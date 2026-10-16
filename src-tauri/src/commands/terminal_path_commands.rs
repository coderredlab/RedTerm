use std::collections::HashSet;
use std::path::{Component, Path};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::StatusCode;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::local_shell_commands::{path_within_home_scope, LocalShellManager};
use super::ssh_commands::SessionManager;
use crate::ssh::SshConnection;

const MAX_REQUESTS: usize = 32;
const MAX_SESSIONS: usize = 32;
const MAX_DIRECTORIES: usize = 32;
const MAX_STAT_PAIRS: usize = 128;
const MAX_PATH_BYTES: usize = 4096;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(30);
const REMOTE_HERDR_PREFIX: &str = "PATH=\"$HOME/.local/bin:$PATH\" herdr";

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TerminalPathResolution {
    pub source: String,
    pub target: String,
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<HerdrSession>,
}

#[derive(Deserialize)]
struct HerdrSession {
    name: String,
    running: bool,
}

#[derive(Deserialize)]
struct WorkspaceResponse {
    result: WorkspaceList,
}

#[derive(Deserialize)]
struct WorkspaceList {
    workspaces: Vec<HerdrWorkspace>,
}

#[derive(Deserialize)]
struct HerdrWorkspace {
    workspace_id: String,
}

#[derive(Deserialize)]
struct PaneResponse {
    result: PaneList,
}

#[derive(Deserialize)]
struct PaneList {
    panes: Vec<HerdrPane>,
}

#[derive(Deserialize)]
struct HerdrPane {
    cwd: Option<String>,
    foreground_cwd: Option<String>,
}

#[derive(Clone, Copy)]
enum HostPaths {
    Local,
    Posix,
}

fn unsafe_text(text: &str) -> bool {
    text.chars().any(|ch| {
        ch.is_control() || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    })
}

fn path_requests(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > MAX_REQUESTS {
        return Err("Path lookup requires between 1 and 32 paths".to_string());
    }
    let mut unique = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let drive_absolute = is_drive_absolute(&path);
        let has_scheme = !drive_absolute
            && path.split_once(':').is_some_and(|(prefix, _)| {
                let mut bytes = prefix.bytes();
                bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
                    && bytes.all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
                    })
            });
        if path.is_empty()
            || path.len() > MAX_PATH_BYTES
            || unsafe_text(&path)
            || path.starts_with("//")
            || path.contains('\\')
            || has_scheme
            || (path.starts_with('~') && path != "~" && !path.starts_with("~/"))
            || path.split('/').any(|part| part == "..")
            || (path != "/" && !path.split('/').any(|part| !part.is_empty() && part != "."))
        {
            return Err(
                "Path lookup accepts only safe filesystem paths without parent traversal"
                    .to_string(),
            );
        }
        if unique.insert(path.clone()) {
            result.push(path);
        }
    }
    Ok(result)
}

fn is_drive_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1..3] == *b":/"
}

fn is_explicit_path(path: &str) -> bool {
    path.starts_with('/') || path.starts_with('~') || is_drive_absolute(path)
}

fn running_session_names(json: &str) -> Result<Vec<String>, String> {
    let list: SessionList = serde_json::from_str(json)
        .map_err(|error| format!("Failed to parse Herdr session metadata: {error}"))?;
    let mut names = Vec::new();
    let mut unique = HashSet::new();
    for session in list.sessions.into_iter().filter(|session| session.running) {
        if session.name.is_empty()
            || session.name.len() > 256
            || session.name.starts_with('-')
            || unsafe_text(&session.name)
        {
            return Err("Herdr returned an unsafe session name".to_string());
        }
        if unique.insert(session.name.clone()) {
            names.push(session.name);
            if names.len() > MAX_SESSIONS {
                return Err("Too many running Herdr sessions for safe path lookup".to_string());
            }
        }
    }
    Ok(names)
}

fn workspace_ids(json: &str) -> Result<Vec<String>, String> {
    let response: WorkspaceResponse = serde_json::from_str(json)
        .map_err(|error| format!("Failed to parse Herdr workspace metadata: {error}"))?;
    let mut ids = Vec::new();
    for workspace in response.result.workspaces {
        let id = workspace.workspace_id;
        if id.is_empty() || id.len() > 256 || id.starts_with('-') || unsafe_text(&id) {
            return Err("Herdr returned an unsafe workspace ID".to_string());
        }
        if !ids.contains(&id) {
            ids.push(id);
            if ids.len() > MAX_DIRECTORIES {
                return Err("Too many Herdr workspaces for safe path lookup".to_string());
            }
        }
    }
    Ok(ids)
}

fn workspace_directories(json: &str, host: HostPaths) -> Result<Vec<String>, String> {
    let response: PaneResponse = serde_json::from_str(json)
        .map_err(|error| format!("Failed to parse Herdr pane metadata: {error}"))?;
    let mut directories = Vec::new();
    for pane in response.result.panes {
        for directory in [pane.cwd, pane.foreground_cwd].into_iter().flatten() {
            if directory.is_empty() {
                continue;
            }
            let valid_absolute = match host {
                HostPaths::Posix => {
                    directory.starts_with('/')
                        && !directory.starts_with("//")
                        && !directory.contains('\\')
                        && !directory.split('/').any(|part| part == "..")
                }
                HostPaths::Local => {
                    Path::new(&directory).is_absolute()
                        && !Path::new(&directory)
                            .components()
                            .any(|part| matches!(part, Component::ParentDir))
                }
            };
            if !valid_absolute || directory.len() > MAX_PATH_BYTES || unsafe_text(&directory) {
                return Err("Herdr returned an unsafe workspace directory".to_string());
            }
            let directory = match host {
                HostPaths::Posix => format!(
                    "/{}",
                    directory
                        .split('/')
                        .filter(|part| !part.is_empty() && *part != ".")
                        .collect::<Vec<_>>()
                        .join("/")
                ),
                HostPaths::Local => Path::new(&directory)
                    .components()
                    .collect::<std::path::PathBuf>()
                    .to_string_lossy()
                    .into_owned(),
            };
            if !directories.contains(&directory) {
                directories.push(directory);
                if directories.len() > MAX_DIRECTORIES {
                    return Err(
                        "Too many Herdr workspace directories for safe path lookup".to_string()
                    );
                }
            }
        }
    }
    Ok(directories)
}

fn append_directories(all: &mut Vec<String>, additions: Vec<String>) -> Result<(), String> {
    for directory in additions {
        if !all.contains(&directory) {
            all.push(directory);
            if all.len() > MAX_DIRECTORIES {
                return Err("Too many Herdr workspace directories for safe path lookup".to_string());
            }
        }
    }
    Ok(())
}

fn candidate_paths(
    paths: &[String],
    directories: &[String],
    host: HostPaths,
    home: Option<&str>,
) -> Result<Vec<TerminalPathResolution>, String> {
    let mut candidates = Vec::new();
    let mut unique = HashSet::new();
    for source in paths {
        let normalized = source
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect::<Vec<_>>()
            .join("/");
        let targets = if source == "~" || source.starts_with("~/") {
            let home = home.ok_or("Home directory is unavailable for path lookup")?;
            let suffix = normalized.strip_prefix("~/").unwrap_or("");
            vec![if suffix.is_empty() {
                home.to_string()
            } else {
                format!("{}/{suffix}", home.trim_end_matches('/'))
            }]
        } else if source.starts_with('/') {
            vec![format!("/{normalized}")]
        } else if is_drive_absolute(source) {
            if matches!(host, HostPaths::Posix) || !cfg!(windows) {
                continue;
            }
            vec![normalized.clone()]
        } else {
            directories
                .iter()
                .map(|directory| match host {
                    HostPaths::Posix => {
                        format!("{}/{normalized}", directory.trim_end_matches('/'))
                    }
                    HostPaths::Local => Path::new(directory)
                        .join(&normalized)
                        .to_string_lossy()
                        .replace('\\', "/"),
                })
                .collect()
        };
        for target in targets {
            #[cfg(windows)]
            if matches!(host, HostPaths::Local) && invalid_windows_path(&target) {
                // A literal POSIX filename may have a valid stripped alternative.
                continue;
            }
            if target.len() > MAX_PATH_BYTES {
                return Err("Resolved filesystem path is too long".to_string());
            }
            // Preserve source aliases: the UI must know which requested candidate exists.
            if unique.insert((source.clone(), target.clone())) {
                candidates.push(TerminalPathResolution {
                    source: source.clone(),
                    target,
                });
                if candidates.len() > MAX_STAT_PAIRS {
                    return Err(
                        "Too many workspace/path combinations for safe path lookup".to_string()
                    );
                }
            }
        }
    }
    Ok(candidates)
}

#[cfg(windows)]
fn invalid_windows_path(path: &str) -> bool {
    let tail = if is_drive_absolute(path) {
        &path[3..]
    } else {
        path
    };
    tail.split('/').any(|part| {
        part.contains([':', '*', '?', '"', '<', '>', '|'])
            || part.ends_with(['.', ' '])
            || matches!(
                part.split('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_uppercase()
                    .as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
    })
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn remote_metadata(
    connection: &SshConnection,
    session: Option<&str>,
    workspace: Option<&str>,
) -> Result<String, String> {
    // Only validated metadata identifiers enter shell arguments, never path text.
    let command = match (session, workspace) {
        (None, _) => format!("{REMOTE_HERDR_PREFIX} session list --json"),
        (Some(name), None) => format!(
            "{REMOTE_HERDR_PREFIX} --session {} workspace list",
            quote_posix(name)
        ),
        (Some(name), Some(workspace)) => format!(
            "{REMOTE_HERDR_PREFIX} --session {} pane list --workspace {}",
            quote_posix(name),
            quote_posix(workspace)
        ),
    };
    let (status, stdout, stderr) =
        tokio::time::timeout(QUERY_TIMEOUT, connection.exec_capture(&command))
            .await
            .map_err(|_| "Herdr metadata query timed out".to_string())?
            .map_err(|error| format!("Herdr metadata query failed: {error}"))?;
    if stdout.len() + stderr.len() > MAX_METADATA_BYTES {
        return Err("Herdr metadata output exceeded 64 KiB".to_string());
    }
    if status != Some(0) || !stderr.is_empty() {
        return Err(format!(
            "Herdr metadata query failed (exit {status:?}): {stderr}"
        ));
    }
    Ok(stdout)
}

async fn bounded_pipe(mut pipe: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    (&mut pipe)
        .take((MAX_METADATA_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Failed to read Herdr metadata: {error}"))?;
    if bytes.len() > MAX_METADATA_BYTES {
        return Err("Herdr metadata output exceeded 64 KiB".to_string());
    }
    Ok(bytes)
}

async fn local_metadata(session: Option<&str>, workspace: Option<&str>) -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Home directory not found")?;
    let mut paths = vec![Path::new(&home).join(".local").join("bin")];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    let mut command = Command::new("herdr");
    command.env(
        "PATH",
        std::env::join_paths(paths).map_err(|error| error.to_string())?,
    );
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("HERDR_")
        {
            command.env_remove(key);
        }
    }
    match (session, workspace) {
        (None, _) => {
            command.args(["session", "list", "--json"]);
        }
        (Some(name), None) => {
            command.args(["--session", name, "workspace", "list"]);
        }
        (Some(name), Some(workspace)) => {
            command.args(["--session", name, "pane", "list", "--workspace", workspace]);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; never steal focus from the terminal.
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to query Herdr metadata: {error}"))?;
    let stdout = child.stdout.take().ok_or("Herdr stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Herdr stderr is unavailable")?;
    tokio::time::timeout(QUERY_TIMEOUT, async {
        let (stdout, stderr, status) =
            tokio::try_join!(bounded_pipe(stdout), bounded_pipe(stderr), async {
                child.wait().await.map_err(|error| error.to_string())
            })?;
        if stdout.len() + stderr.len() > MAX_METADATA_BYTES {
            return Err("Herdr metadata output exceeded 64 KiB".to_string());
        }
        if !status.success() || !stderr.is_empty() {
            return Err(format!(
                "Herdr metadata query failed ({status}): {}",
                String::from_utf8_lossy(&stderr)
            ));
        }
        String::from_utf8(stdout).map_err(|_| "Herdr metadata is not valid UTF-8".to_string())
    })
    .await
    .map_err(|_| "Herdr metadata query timed out".to_string())?
}

fn local_scope_directories(directories: Vec<String>) -> Result<Vec<String>, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or("Home directory not found")?;
    let canonical_home = path_within_home_scope(&home)?
        .ok_or("The local home directory is outside the Files browsing scope")?;
    let mut eligible = Vec::new();
    for directory in directories {
        let path = Path::new(&directory);
        // Exclude unsupported roots before touching their filesystem, so an
        // unrelated /tmp workspace cannot block an eligible home workspace.
        if !path.starts_with(&home) && !path.starts_with(&canonical_home) {
            continue;
        }
        if let Some(scoped) = path_within_home_scope(path)? {
            let scoped = scoped.to_string_lossy().replace('\\', "/");
            if !eligible.contains(&scoped) {
                eligible.push(scoped);
            }
        }
    }
    if eligible.is_empty() {
        return Err(
            "No running Herdr workspace is available within the local Files home-directory scope"
                .to_string(),
        );
    }
    Ok(eligible)
}

async fn local_existing_candidates(
    candidates: Vec<TerminalPathResolution>,
) -> Result<Vec<TerminalPathResolution>, String> {
    tokio::task::spawn_blocking(move || {
        let mut existing = Vec::new();
        for candidate in candidates {
            let Some(path) = path_within_home_scope(Path::new(&candidate.target))? else {
                continue;
            };
            match std::fs::metadata(path) {
                Ok(metadata) if metadata.is_file() || metadata.is_dir() => existing.push(candidate),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Failed to inspect workspace path: {error}")),
            }
        }
        Ok(existing)
    })
    .await
    .map_err(|error| format!("Workspace path lookup failed: {error}"))?
}

fn explicit_lookup_complete(paths: &[String], existing: &[TerminalPathResolution]) -> bool {
    paths.iter().all(|path| is_explicit_path(path))
        || paths.first().is_some_and(|primary| {
            is_explicit_path(primary)
                && existing
                    .iter()
                    .filter(|item| item.source == *primary)
                    .count()
                    == 1
        })
}

async fn resolve_local(paths: &[String]) -> Result<Vec<TerminalPathResolution>, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Home directory not found")?;
    let home = home
        .to_str()
        .ok_or("Home directory is not valid Unicode")?
        .replace('\\', "/");
    let explicit =
        local_existing_candidates(candidate_paths(paths, &[], HostPaths::Local, Some(&home))?)
            .await?;
    if explicit_lookup_complete(paths, &explicit) {
        return Ok(explicit);
    }
    let sessions = running_session_names(&local_metadata(None, None).await?)?;
    let mut directories = Vec::new();
    for session in sessions {
        for workspace in workspace_ids(&local_metadata(Some(&session), None).await?)? {
            append_directories(
                &mut directories,
                workspace_directories(
                    &local_metadata(Some(&session), Some(&workspace)).await?,
                    HostPaths::Local,
                )?,
            )?;
        }
    }
    let directories = tokio::task::spawn_blocking(move || local_scope_directories(directories))
        .await
        .map_err(|error| format!("Workspace scope lookup failed: {error}"))??;
    local_existing_candidates(candidate_paths(
        paths,
        &directories,
        HostPaths::Local,
        Some(&home),
    )?)
    .await
}

async fn resolve_remote(
    connection: &SshConnection,
    paths: &[String],
) -> Result<Vec<TerminalPathResolution>, String> {
    let sftp = connection
        .open_sftp()
        .await
        .map_err(|error| format!("Filesystem SFTP lookup failed: {error}"))?;
    let home = if paths
        .iter()
        .any(|path| path == "~" || path.starts_with("~/"))
    {
        let home = sftp
            .canonicalize(".")
            .await
            .map_err(|error| format!("Failed to resolve remote home directory: {error}"))?;
        if !home.starts_with('/')
            || home.starts_with("//")
            || home.contains('\\')
            || home.len() > MAX_PATH_BYTES
            || unsafe_text(&home)
            || home.split('/').any(|part| part == "..")
        {
            return Err("SFTP returned an unsafe home directory".to_string());
        }
        Some(home)
    } else {
        None
    };
    let explicit = remote_existing_candidates(
        &sftp,
        candidate_paths(paths, &[], HostPaths::Posix, home.as_deref())?,
    )
    .await?;
    if explicit_lookup_complete(paths, &explicit) {
        return Ok(explicit);
    }
    let sessions = running_session_names(&remote_metadata(connection, None, None).await?)?;
    let mut directories = Vec::new();
    for session in sessions {
        for workspace in workspace_ids(&remote_metadata(connection, Some(&session), None).await?)? {
            append_directories(
                &mut directories,
                workspace_directories(
                    &remote_metadata(connection, Some(&session), Some(&workspace)).await?,
                    HostPaths::Posix,
                )?,
            )?;
        }
    }
    remote_existing_candidates(
        &sftp,
        candidate_paths(paths, &directories, HostPaths::Posix, home.as_deref())?,
    )
    .await
}

async fn remote_existing_candidates(
    sftp: &russh_sftp::client::SftpSession,
    candidates: Vec<TerminalPathResolution>,
) -> Result<Vec<TerminalPathResolution>, String> {
    let mut existing = Vec::new();
    for candidate in candidates {
        match sftp.metadata(&candidate.target).await {
            Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_dir() => {
                existing.push(candidate)
            }
            Ok(_) => {}
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {}
            Err(error) => return Err(format!("Failed to inspect remote workspace path: {error}")),
        }
    }
    Ok(existing)
}

/// Resolve existing same-session filesystem targets without writing to a terminal.
/// Mixed-source discovery only skips metadata for a uniquely resolved explicit primary.
#[tauri::command]
pub async fn terminal_resolve_paths(
    session_manager: State<'_, Arc<SessionManager>>,
    local_shell_manager: State<'_, Arc<LocalShellManager>>,
    kind: String,
    session_id: String,
    paths: Vec<String>,
) -> Result<Vec<TerminalPathResolution>, String> {
    let paths = path_requests(paths)?;
    match kind.as_str() {
        "local" => {
            let identity = local_shell_manager
                .terminal_path_identity(&session_id)
                .await?;
            let result = tokio::time::timeout(LOOKUP_TIMEOUT, resolve_local(&paths)).await;
            local_shell_manager
                .validate_terminal_path_identity(&session_id, &identity)
                .await?;
            result.map_err(|_| "Workspace path lookup timed out".to_string())?
        }
        "ssh" => {
            let connection = session_manager
                .terminal_path_connection(&session_id)
                .await?;
            let result =
                tokio::time::timeout(LOOKUP_TIMEOUT, resolve_remote(&connection, &paths)).await;
            session_manager
                .validate_terminal_path_connection(&session_id, &connection)
                .await?;
            result.map_err(|_| "Workspace path lookup timed out".to_string())?
        }
        _ => Err("Unsupported terminal session kind".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_actual_herdr_envelopes_and_preserves_projects() {
        let names = running_session_names(r#"{"sessions":[{"name":"default","running":true,"default":true,"session_dir":"/tmp/herdr/default","socket_path":"/tmp/herdr/default/socket"},{"name":"other project","running":true},{"name":"stopped","running":false}]}"#).unwrap();
        assert_eq!(names, ["default", "other project"]);
        let dirs = workspace_directories(r#"{"id":"query","result":{"panes":[{"pane_id":"w1:p1","cwd":"/home/coderred","foreground_cwd":"/home/coderred/Projects/coderred-video"},{"cwd":"/home/coderred/Projects/coderred-video/","foreground_cwd":null},{"cwd":"/home/coderred/Projects/other"}]}}"#, HostPaths::Posix).unwrap();
        assert_eq!(
            dirs,
            [
                "/home/coderred",
                "/home/coderred/Projects/coderred-video",
                "/home/coderred/Projects/other"
            ]
        );
        let candidates = candidate_paths(
            &["exports/short.mp4".to_string()],
            &dirs,
            HostPaths::Posix,
            None,
        )
        .unwrap();
        assert_eq!(
            candidates[1].target,
            "/home/coderred/Projects/coderred-video/exports/short.mp4"
        );
        assert_eq!(candidates.len(), 3);
    }

    #[test]
    fn rejects_unsafe_requests_and_preserves_literal_names() {
        for bad in [
            "",
            "//foreign-host/a",
            "../a",
            "a/../b",
            "/home/../etc",
            "~/../etc",
            "https://host/a",
            "file:///home/a",
            "~other/a",
            "a\\..\\b",
            "a\u{001b}[1m",
            "a\u{202e}b",
            ".",
            "./",
        ] {
            assert!(path_requests(vec![bad.to_string()]).is_err(), "{bad:?}");
        }
        let paths = path_requests(vec![
            "./exports/a b'$(touch marker).mp4".into(),
            "./exports/a b'$(touch marker).mp4".into(),
        ])
        .unwrap();
        assert_eq!(paths.len(), 1);
        assert!(path_requests(vec!["safe".into(); MAX_REQUESTS + 1]).is_err());
    }

    #[test]
    fn malformed_metadata_is_not_an_empty_success() {
        for bad in [
            "{}",
            "{\"sessions\":null}",
            "{\"sessions\":[{\"name\":\"x\"}]}",
            "not json",
        ] {
            assert!(running_session_names(bad).is_err());
        }
        for bad in [
            "{}",
            "{\"result\":{}}",
            "{\"error\":\"gone\"}",
            "{\"result\":{\"panes\":[{\"cwd\":42}]}}",
        ] {
            assert!(workspace_directories(bad, HostPaths::Posix).is_err());
        }
        for directory in ["relative", "/home/../etc", "//host/share", "/home/\n"] {
            let json = serde_json::json!({"result":{"panes":[{"cwd":directory}]}}).to_string();
            assert!(workspace_directories(&json, HostPaths::Posix).is_err());
        }
        assert!(running_session_names(r#"{"sessions":[]}"#)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn session_names_are_bounded_and_shell_quoted() {
        let name = "project ' ; $(touch /tmp/marker)";
        assert_eq!(quote_posix(name), "'project '\\'' ; $(touch /tmp/marker)'");
        let json = serde_json::json!({"sessions":[{"name":name,"running":true}]}).to_string();
        assert_eq!(running_session_names(&json).unwrap(), [name]);
        for name in ["-x", "", "x\ny"] {
            let json = serde_json::json!({"sessions":[{"name":name,"running":true}]}).to_string();
            assert!(running_session_names(&json).is_err());
        }
        let json = serde_json::json!({"sessions":(0..=MAX_SESSIONS).map(|n| serde_json::json!({"name":format!("s{n}"),"running":true})).collect::<Vec<_>>()}).to_string();
        assert!(running_session_names(&json).is_err());
    }

    #[test]
    fn lexical_aliases_preserve_requested_source_with_one_normalized_target() {
        let dirs = workspace_directories(
            r#"{"result":{"panes":[{"cwd":"/project//./","foreground_cwd":"/project/"}]}}"#,
            HostPaths::Posix,
        )
        .unwrap();
        assert_eq!(dirs, ["/project"]);
        let requests = path_requests(vec![
            "./exports//clip.mp4".into(),
            "exports/clip.mp4".into(),
        ])
        .unwrap();
        let candidates = candidate_paths(&requests, &dirs, HostPaths::Posix, None).unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates
            .iter()
            .all(|candidate| candidate.target == "/project/exports/clip.mp4"));
        assert_eq!(candidates[0].source, "./exports//clip.mp4");
        assert_eq!(candidates[1].source, "exports/clip.mp4");
    }

    #[test]
    fn excessive_candidates_fail_instead_of_truncating() {
        let dirs: Vec<_> = (0..=MAX_DIRECTORIES)
            .map(|n| format!("/workspace/{n}"))
            .collect();
        assert!(append_directories(&mut Vec::new(), dirs.clone()).is_err());
        assert!(candidate_paths(
            &(0..5).map(|n| format!("export{n}.mp4")).collect::<Vec<_>>(),
            &dirs[..MAX_DIRECTORIES],
            HostPaths::Posix,
            None
        )
        .is_err());
        let long = format!("/{}", "a".repeat(MAX_PATH_BYTES - 1));
        assert!(candidate_paths(&["x".into()], &[long], HostPaths::Posix, None).is_err());
    }

    #[tokio::test]
    async fn local_existence_returns_all_projects_and_no_missing_target() {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .unwrap();
        let root = Path::new(&home).join(format!(
            ".redterm-workspace-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        for project in ["first", "second"] {
            std::fs::create_dir_all(root.join(project).join("exports")).unwrap();
            std::fs::write(root.join(project).join("exports/clip.mp4"), b"fixture").unwrap();
        }
        let dirs: Vec<_> = ["first", "second"]
            .iter()
            .map(|project| root.join(project).to_str().unwrap().to_string())
            .collect();
        let outside = Path::new(&home).parent().unwrap().join(format!(
            "redterm-unsupported-workspace-{}",
            uuid::Uuid::new_v4()
        ));
        let mut mixed_dirs = dirs.clone();
        mixed_dirs.push(outside.to_str().unwrap().to_string());
        let dirs = local_scope_directories(mixed_dirs).unwrap();
        assert_eq!(dirs.len(), 2);
        assert!(local_scope_directories(vec![outside.to_str().unwrap().to_string()]).is_err());
        let requests = path_requests(vec![
            "exports/clip.mp4".into(),
            "exports/missing.mp4".into(),
        ])
        .unwrap();
        let existing = local_existing_candidates(
            candidate_paths(&requests, &dirs, HostPaths::Local, None).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(existing.len(), 2);
        assert!(existing
            .iter()
            .all(|item| item.source == "exports/clip.mp4"));
        assert_ne!(existing[0].target, existing[1].target);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_location_lookup_keeps_literal_and_stripped_existing_files() {
        let root = Path::new(&std::env::var_os("HOME").unwrap()).join(format!(
            ".redterm-source-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).unwrap();
            }
        }
        std::fs::create_dir_all(root.join("src")).unwrap();
        let _cleanup = Cleanup(root.clone());
        for name in ["main.ts", "main.ts:12:4"] {
            std::fs::write(root.join("src").join(name), b"source fixture").unwrap();
        }
        let requests = path_requests(vec!["src/main.ts:12:4".into(), "src/main.ts".into()])
            .expect("source-location alternatives are valid relative filenames");
        let directories = vec![root.to_str().unwrap().to_string()];
        let existing = local_existing_candidates(
            candidate_paths(&requests, &directories, HostPaths::Local, None).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            existing
                .iter()
                .map(|item| item.source.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["src/main.ts:12:4", "src/main.ts"])
        );
    }

    #[test]
    fn enumerates_unfocused_workspace_ids_and_rejects_malformed_metadata() {
        let workspaces = workspace_ids(r#"{"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[{"workspace_id":"wV","focused":false},{"workspace_id":"w12","focused":true},{"workspace_id":"wV"}]}}"#).unwrap();
        assert_eq!(workspaces, ["wV", "w12"]);
        for bad in [
            "{}",
            r#"{"result":{"workspaces":null}}"#,
            r#"{"result":{"workspaces":[{}]}}"#,
            r#"{"result":{"workspaces":[{"workspace_id":"-option"}]}}"#,
            r#"{"result":{"workspaces":[{"workspace_id":"w\n1"}]}}"#,
        ] {
            assert!(workspace_ids(bad).is_err());
        }
        let oversized = serde_json::json!({"result":{"workspaces":(0..=MAX_DIRECTORIES)
            .map(|n| serde_json::json!({"workspace_id":format!("w{n}")})).collect::<Vec<_>>()}})
        .to_string();
        assert!(workspace_ids(&oversized).is_err());
    }

    #[test]
    fn absolute_and_home_candidates_do_not_need_workspace_directories() {
        let sources = path_requests(vec![
            "/home/test//./clip.mp4:12:4".into(),
            "/home/test/clip.mp4".into(),
            "~/exports//./clip.mp4".into(),
            "~".into(),
            "relative/clip.mp4".into(),
        ])
        .unwrap();
        let candidates =
            candidate_paths(&sources, &[], HostPaths::Posix, Some("/home/test")).unwrap();
        assert_eq!(candidates.len(), 4);
        assert_eq!(candidates[0].source, sources[0]);
        assert_eq!(candidates[0].target, "/home/test/clip.mp4:12:4");
        assert_eq!(candidates[1].target, "/home/test/clip.mp4");
        assert_eq!(candidates[2].target, "/home/test/exports/clip.mp4");
        assert_eq!(candidates[3].target, "/home/test");
        assert_eq!(
            candidate_paths(&["~".into()], &[], HostPaths::Posix, Some("/")).unwrap()[0].target,
            "/"
        );
        assert!(candidate_paths(&["~/clip".into()], &[], HostPaths::Posix, None).is_err());
        assert!(
            candidate_paths(&["C:/clip.mp4".into()], &[], HostPaths::Posix, None)
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn local_explicit_lookup_returns_existing_sources_without_herdr() {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .unwrap();
        let name = format!(".redterm-direct-path-test-{}", uuid::Uuid::new_v4());
        let root = Path::new(&home).join(&name);
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        std::fs::create_dir_all(&root).unwrap();
        let _cleanup = Cleanup(root.clone());
        std::fs::write(root.join("clip.mp4"), b"fixture").unwrap();
        let absolute = root.join("clip.mp4").to_str().unwrap().replace('\\', "/");
        let home_source = format!("~/{name}/clip.mp4");
        let missing = format!("~/{name}/missing.mp4");
        let sources = path_requests(vec![absolute.clone(), home_source.clone(), missing]).unwrap();
        let existing = resolve_local(&sources).await.unwrap();
        assert_eq!(existing.len(), 2);
        assert_eq!(existing[0].source, absolute);
        assert_eq!(existing[1].source, home_source);
        assert_eq!(existing[0].target, existing[1].target);
        // A uniquely resolved explicit primary remains usable even if relative
        // alternatives would need unavailable host workspace metadata.
        let mixed = resolve_local(&[absolute.clone(), "unrelated/missing.mp4".into()])
            .await
            .unwrap();
        assert_eq!(
            mixed,
            vec![TerminalPathResolution {
                source: absolute.clone(),
                target: absolute,
            }]
        );
        assert!(resolve_local(&[format!("~/{name}/missing.mp4")])
            .await
            .unwrap()
            .is_empty());
        let outside = Path::new(&home)
            .parent()
            .unwrap()
            .to_str()
            .unwrap()
            .replace('\\', "/");
        assert!(resolve_local(&[outside]).await.unwrap().is_empty());
        // Filesystem errors other than a missing candidate remain errors.
        #[cfg(unix)]
        assert!(resolve_local(&[format!("~/{name}/clip.mp4/child")])
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_explicit_symlink_cannot_escape_home_scope() {
        let home = std::env::var_os("HOME").unwrap();
        let root =
            Path::new(&home).join(format!(".redterm-link-scope-test-{}", uuid::Uuid::new_v4()));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        std::fs::create_dir_all(&root).unwrap();
        let _cleanup = Cleanup(root.clone());
        std::os::unix::fs::symlink("/", root.join("outside")).unwrap();
        assert!(
            resolve_local(&[root.join("outside").to_str().unwrap().into()])
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn alternate_explicit_target_does_not_hide_unresolved_primary() {
        let existing = vec![TerminalPathResolution {
            source: "/home/test/alternate.mp4".into(),
            target: "/home/test/alternate.mp4".into(),
        }];
        assert!(!explicit_lookup_complete(
            &["exports/primary.mp4".into(), existing[0].source.clone()],
            &existing,
        ));
        assert!(!explicit_lookup_complete(
            &[
                "/home/test/missing.mp4".into(),
                existing[0].source.clone(),
                "exports/primary.mp4".into()
            ],
            &existing,
        ));
        assert!(explicit_lookup_complete(
            &[existing[0].source.clone(), "exports/primary.mp4".into()],
            &existing,
        ));
        assert!(explicit_lookup_complete(
            &["/home/test/missing.mp4".into(), "~/missing.mp4".into()],
            &[],
        ));
    }

    #[cfg(windows)]
    #[test]
    fn invalid_windows_candidate_does_not_discard_stripped_alternative() {
        let sources = path_requests(vec![
            "C:/Users/test/src/main.ts:12:4".into(),
            "C:/Users/test/src/main.ts".into(),
            "src/NUL.txt".into(),
            "src/valid.txt".into(),
        ])
        .unwrap();
        let candidates =
            candidate_paths(&sources, &["C:/Users/test".into()], HostPaths::Local, None).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].source, "C:/Users/test/src/main.ts");
        assert_eq!(candidates[1].source, "src/valid.txt");
    }

    #[test]
    fn filesystem_root_resolves_without_a_workspace_and_empty_relative_paths_stay_invalid() {
        let paths = path_requests(vec!["/".into()]).expect("filesystem root is an explicit path");
        let targets = candidate_paths(&paths, &[], HostPaths::Posix, None).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].target, "/");
        for invalid in ["", ".", "./"] {
            assert!(path_requests(vec![invalid.into()]).is_err());
        }
    }
}

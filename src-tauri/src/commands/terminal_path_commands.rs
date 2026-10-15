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

fn relative_requests(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > MAX_REQUESTS {
        return Err("Path lookup requires between 1 and 32 relative paths".to_string());
    }
    let mut unique = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let has_scheme = path.split_once(':').is_some_and(|(prefix, _)| {
            let mut bytes = prefix.bytes();
            bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
                && bytes
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
        });
        if path.is_empty()
            || path.len() > MAX_PATH_BYTES
            || unsafe_text(&path)
            || path.starts_with(['/', '\\', '~'])
            || has_scheme
            || path.contains('\\')
            || path.split('/').any(|part| part == "..")
            || !path.split('/').any(|part| !part.is_empty() && part != ".")
        {
            return Err(
                "Path lookup accepts only safe relative paths without parent traversal".to_string(),
            );
        }
        if unique.insert(path.clone()) {
            result.push(path);
        }
    }
    Ok(result)
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
) -> Result<Vec<TerminalPathResolution>, String> {
    if paths.len().saturating_mul(directories.len()) > MAX_STAT_PAIRS {
        return Err("Too many workspace/path combinations for safe path lookup".to_string());
    }
    let mut candidates = Vec::new();
    let mut unique = HashSet::new();
    for source in paths {
        let mut relative = String::with_capacity(source.len());
        for part in source
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
        {
            if !relative.is_empty() {
                relative.push('/');
            }
            relative.push_str(part);
        }
        #[cfg(windows)]
        if matches!(host, HostPaths::Local) && relative.contains(':') {
            // NTFS stream/invalid-name syntax is not a browsable directory entry.
            // Keep the valid source-location alternatives in the same batch.
            continue;
        }
        for directory in directories {
            let target = match host {
                HostPaths::Posix => format!("{}/{relative}", directory.trim_end_matches('/')),
                HostPaths::Local => Path::new(directory)
                    .join(&relative)
                    .to_str()
                    .ok_or("Workspace path is not valid Unicode")?
                    .replace('\\', "/"),
            };
            if target.len() > MAX_PATH_BYTES {
                return Err("Resolved workspace path is too long".to_string());
            }
            if unique.insert(target.clone()) {
                candidates.push(TerminalPathResolution {
                    source: source.clone(),
                    target,
                });
            }
        }
    }
    Ok(candidates)
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn remote_metadata(
    connection: &SshConnection,
    session: Option<&str>,
) -> Result<String, String> {
    // Only metadata-derived names enter a fixed read-only command, as one quoted argument.
    // Terminal text never enters a shell command or the interactive PTY.
    let command = match session {
        None => format!("{REMOTE_HERDR_PREFIX} session list --json"),
        Some(name) => format!(
            "{REMOTE_HERDR_PREFIX} --session {} pane list",
            quote_posix(name)
        ),
    };
    let (status, stdout, stderr) =
        tokio::time::timeout(QUERY_TIMEOUT, connection.exec_capture(&command))
            .await
            .map_err(|_| "Herdr metadata query timed out".to_string())?
            .map_err(|error| format!("Herdr metadata query failed: {error}"))?;
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

async fn local_metadata(session: Option<&str>) -> Result<String, String> {
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
    match session {
        None => {
            command.args(["session", "list", "--json"]);
        }
        Some(name) => {
            command.args(["--session", name, "pane", "list"]);
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
        // Herdr lists every live workspace. Exclude unsupported roots before
        // touching their filesystem, rather than letting an unrelated /tmp
        // pane prevent lookup in an otherwise eligible home workspace.
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

async fn resolve_local(paths: &[String]) -> Result<Vec<TerminalPathResolution>, String> {
    let sessions = running_session_names(&local_metadata(None).await?)?;
    let mut directories = Vec::new();
    for session in sessions {
        append_directories(
            &mut directories,
            workspace_directories(&local_metadata(Some(&session)).await?, HostPaths::Local)?,
        )?;
    }
    let directories = tokio::task::spawn_blocking(move || local_scope_directories(directories))
        .await
        .map_err(|error| format!("Workspace scope lookup failed: {error}"))??;
    local_existing_candidates(candidate_paths(paths, &directories, HostPaths::Local)?).await
}

async fn resolve_remote(
    connection: &SshConnection,
    paths: &[String],
) -> Result<Vec<TerminalPathResolution>, String> {
    let sessions = running_session_names(&remote_metadata(connection, None).await?)?;
    let mut directories = Vec::new();
    for session in sessions {
        append_directories(
            &mut directories,
            workspace_directories(
                &remote_metadata(connection, Some(&session)).await?,
                HostPaths::Posix,
            )?,
        )?;
    }
    let candidates = candidate_paths(paths, &directories, HostPaths::Posix)?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let sftp = connection
        .open_sftp()
        .await
        .map_err(|error| format!("Workspace SFTP lookup failed: {error}"))?;
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

/// Read-only discovery produces choices, never evidence of a historical pane's cwd.
/// The UI must retain explicit full-path consent, even when only one target exists.
#[tauri::command]
pub async fn terminal_resolve_paths(
    session_manager: State<'_, Arc<SessionManager>>,
    local_shell_manager: State<'_, Arc<LocalShellManager>>,
    kind: String,
    session_id: String,
    paths: Vec<String>,
) -> Result<Vec<TerminalPathResolution>, String> {
    let paths = relative_requests(paths)?;
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
        let candidates =
            candidate_paths(&["exports/short.mp4".to_string()], &dirs, HostPaths::Posix).unwrap();
        assert_eq!(
            candidates[1].target,
            "/home/coderred/Projects/coderred-video/exports/short.mp4"
        );
        assert_eq!(candidates.len(), 3);
    }

    #[test]
    fn rejects_unsafe_relative_requests_and_preserves_literal_names() {
        for bad in [
            "",
            "/tmp/a",
            "../a",
            "a/../b",
            "https://host/a",
            "C:/a",
            "~/a",
            "a\\..\\b",
            "a\u{001b}[1m",
            "a\u{202e}b",
            ".",
            "./",
        ] {
            assert!(relative_requests(vec![bad.to_string()]).is_err(), "{bad:?}");
        }
        let paths = relative_requests(vec![
            "./exports/a b'$(touch marker).mp4".into(),
            "./exports/a b'$(touch marker).mp4".into(),
        ])
        .unwrap();
        assert_eq!(paths.len(), 1);
        assert!(relative_requests(vec!["safe".into(); MAX_REQUESTS + 1]).is_err());
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
    fn lexical_aliases_do_not_duplicate_workspace_choices() {
        let dirs = workspace_directories(
            r#"{"result":{"panes":[{"cwd":"/project//./","foreground_cwd":"/project/"}]}}"#,
            HostPaths::Posix,
        )
        .unwrap();
        assert_eq!(dirs, ["/project"]);
        let requests = relative_requests(vec![
            "./exports//clip.mp4".into(),
            "exports/clip.mp4".into(),
        ])
        .unwrap();
        let candidates = candidate_paths(&requests, &dirs, HostPaths::Posix).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].target, "/project/exports/clip.mp4");
    }

    #[test]
    fn excessive_choices_fail_instead_of_truncating() {
        let dirs: Vec<_> = (0..=MAX_DIRECTORIES)
            .map(|n| format!("/workspace/{n}"))
            .collect();
        assert!(append_directories(&mut Vec::new(), dirs.clone()).is_err());
        assert!(candidate_paths(
            &vec!["export.mp4".into(); 5],
            &dirs[..MAX_DIRECTORIES],
            HostPaths::Posix
        )
        .is_err());
        let long = format!("/{}", "a".repeat(MAX_PATH_BYTES - 1));
        assert!(candidate_paths(&["x".into()], &[long], HostPaths::Posix).is_err());
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
        let requests = relative_requests(vec![
            "exports/clip.mp4".into(),
            "exports/missing.mp4".into(),
        ])
        .unwrap();
        let existing =
            local_existing_candidates(candidate_paths(&requests, &dirs, HostPaths::Local).unwrap())
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
        let requests = relative_requests(vec!["src/main.ts:12:4".into(), "src/main.ts".into()])
            .expect("source-location alternatives are valid relative filenames");
        let directories = vec![root.to_str().unwrap().to_string()];
        let existing = local_existing_candidates(
            candidate_paths(&requests, &directories, HostPaths::Local).unwrap(),
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
}

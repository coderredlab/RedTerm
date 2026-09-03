use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, RwLock};

use super::ssh_commands::{
    append_cleanup_error, claim_download_destination, ensure_local_sftp_preview_dir,
    make_download_progress_emitter, resolve_sftp_preview_cache_file, sanitize_file_name,
    SftpDownloadedFile, SftpFileContent, MAX_SFTP_PREVIEW_DOWNLOAD_BYTES,
};
use crate::ssh::SftpDirEntry;

const MAX_LOCAL_PREVIEW_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LOCAL_LIST_ENTRIES: usize = 10_000;
const LOCAL_SHELL_TERM: &str = "xterm-256color";

pub struct LocalShellManager {
    shells: RwLock<HashMap<String, LocalShell>>,
}

struct LocalShell {
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// FIFO to the writer pump — keystrokes must reach the PTY in the order
    /// they were sent, even though each write command is a separate task.
    writer_tx: mpsc::Sender<Vec<u8>>,
    recent_output: Arc<Mutex<LocalRecentOutput>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

const MAX_CONCURRENT_LOCAL_SHELLS: usize = 16;
const MAX_RECENT_LOCAL_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECENT_LOCAL_CHUNK_COUNT: usize = 4096;

#[derive(Clone, serde::Serialize)]
pub struct LocalShellDataChunk {
    pub seq: u64,
    pub data: Vec<u8>,
}

#[derive(Default)]
struct LocalRecentOutput {
    chunks: VecDeque<LocalShellDataChunk>,
    total_bytes: usize,
    last_seq: u64,
}
impl LocalRecentOutput {
    fn push(&mut self, chunk: LocalShellDataChunk) {
        self.last_seq = self.last_seq.max(chunk.seq);
        self.total_bytes = self.total_bytes.saturating_add(chunk.data.len());
        self.chunks.push_back(chunk);
        while self.chunks.len() > MAX_RECENT_LOCAL_CHUNK_COUNT
            || self.total_bytes > MAX_RECENT_LOCAL_CHUNK_BYTES
        {
            if let Some(removed) = self.chunks.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
        }
    }

    fn push_data(&mut self, data: Vec<u8>) -> LocalShellDataChunk {
        self.last_seq = self.last_seq.saturating_add(1);
        let chunk = LocalShellDataChunk {
            seq: self.last_seq,
            data,
        };
        self.push(chunk.clone());
        chunk
    }
    fn chunks_after(
        &self,
        after_seq: u64,
        last_emitted_seq: u64,
    ) -> Result<Vec<LocalShellDataChunk>, String> {
        let first_retained_seq = self
            .chunks
            .front()
            .map(|chunk| chunk.seq)
            .unwrap_or(last_emitted_seq.saturating_add(1));
        if after_seq < last_emitted_seq && first_retained_seq > after_seq.saturating_add(1) {
            return Err(
                "Local shell output history no longer covers the requested sequence".to_string(),
            );
        }
        Ok(self
            .chunks
            .iter()
            .filter(|chunk| chunk.seq > after_seq)
            .cloned()
            .collect())
    }
}

impl LocalShellManager {
    pub fn new() -> Self {
        Self {
            shells: RwLock::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub async fn local_shell_start(
    app: AppHandle,
    manager: State<'_, Arc<LocalShellManager>>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    {
        let shells = manager.shells.read().await;
        if shells.len() >= MAX_CONCURRENT_LOCAL_SHELLS {
            return Err(format!(
                "Too many local shells open (limit {})",
                MAX_CONCURRENT_LOCAL_SHELLS
            ));
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open pseudo terminal: {}", e))?;

    // Uses the user's default login shell ($SHELL / passwd entry, PowerShell
    // on Windows) with a working directory at the user's home.
    let mut command = CommandBuilder::new_default_prog();
    configure_local_shell_command(&mut command);

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to spawn local shell: {}", e))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to attach terminal reader: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to attach terminal writer: {}", e))?;

    // Serialized writer pump: writes arrive from separate async command
    // invocations, so they must go through a FIFO or fast typing reorders
    // the bytes on the PTY.
    let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(256);
    std::thread::spawn(move || {
        let mut writer = writer;
        while let Some(data) = writer_rx.blocking_recv() {
            if data.is_empty() {
                continue;
            }
            if writer
                .write_all(&data)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });

    let session_id = uuid::Uuid::new_v4().to_string();
    let recent_output = Arc::new(Mutex::new(LocalRecentOutput::default()));
    manager.shells.write().await.insert(
        session_id.clone(),
        LocalShell {
            master: Mutex::new(pair.master),
            writer_tx,
            recent_output: recent_output.clone(),
            child: Mutex::new(child),
        },
    );

    let data_event = format!("local-data-{}", session_id);
    let exit_event = format!("local-exit-{}", session_id);
    let emitter = app.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = match recent_output.lock() {
                        Ok(mut output) => output.push_data(buffer[..read].to_vec()),
                        Err(_) => break,
                    };
                    if emitter.emit(&data_event, &chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = emitter.emit(&exit_event, ());
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn local_shell_get_output(
    manager: State<'_, Arc<LocalShellManager>>,
    session_id: String,
    after_seq: u64,
) -> Result<Vec<LocalShellDataChunk>, String> {
    let recent_output = {
        let shells = manager.shells.read().await;
        shells
            .get(&session_id)
            .ok_or_else(|| "Local shell not found".to_string())?
            .recent_output
            .clone()
    };
    let output = recent_output
        .lock()
        .map_err(|_| "Local shell output history is unavailable".to_string())?;
    output.chunks_after(after_seq, output.last_seq)
}

fn local_home_dir_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

fn is_parent_terminal_session_env_key(key: &std::ffi::OsStr) -> bool {
    key.to_str()
        .and_then(|key| key.get(..6))
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("HERDR_"))
}

fn remove_parent_terminal_session_env_keys<I>(command: &mut CommandBuilder, keys: I)
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    for key in keys {
        if is_parent_terminal_session_env_key(&key) {
            command.env_remove(key);
        }
    }
}

fn configure_local_shell_command(command: &mut CommandBuilder) {
    remove_parent_terminal_session_env_keys(command, std::env::vars_os().map(|(key, _)| key));
    command.env("TERM", LOCAL_SHELL_TERM);
    if let Some(home) = local_home_dir_path() {
        command.cwd(home);
    }
}

#[cfg(test)]
mod command_configuration_tests {
    use super::*;

    #[test]
    fn removes_only_parent_terminal_session_environment() {
        let mut command = CommandBuilder::new("test-shell");
        command.env("HERDR_TEST_SENTINEL", "nested");
        command.env("REDTERM_TEST_SENTINEL", "kept");

        remove_parent_terminal_session_env_keys(
            &mut command,
            [
                std::ffi::OsString::from("HERDR_TEST_SENTINEL"),
                std::ffi::OsString::from("REDTERM_TEST_SENTINEL"),
            ],
        );

        assert_eq!(command.get_env("HERDR_TEST_SENTINEL"), None);
        assert_eq!(
            command.get_env("REDTERM_TEST_SENTINEL"),
            Some(std::ffi::OsStr::new("kept"))
        );
    }
}

#[tauri::command]
pub async fn local_shell_write(
    manager: State<'_, Arc<LocalShellManager>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // Queue onto the shell's FIFO; the pump preserves send order even when
    // writes come from separate concurrent command invocations.
    let tx = {
        let shells = manager.shells.read().await;
        shells
            .get(&session_id)
            .map(|shell| shell.writer_tx.clone())
            .ok_or_else(|| "Local shell not found".to_string())?
    };
    tx.send(data)
        .await
        .map_err(|_| "Local shell is no longer running".to_string())
}

#[tauri::command]
pub async fn local_shell_resize(
    manager: State<'_, Arc<LocalShellManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let shells = manager.shells.read().await;
    let shell = shells
        .get(&session_id)
        .ok_or_else(|| "Local shell not found".to_string())?;
    let master = shell
        .master
        .lock()
        .map_err(|_| "Local shell is unavailable".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize local shell: {}", e))
}

#[tauri::command]
pub async fn local_shell_disconnect(
    manager: State<'_, Arc<LocalShellManager>>,
    session_id: String,
) -> Result<(), String> {
    // Remove outside any guard scope so kill/wait (which can block) never
    // stalls other local shell commands.
    let shell = {
        let mut shells = manager.shells.write().await;
        shells.remove(&session_id)
    };
    if let Some(shell) = shell {
        if let Ok(mut child) = shell.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        drop(shell.master);
    }
    Ok(())
}

fn unix_mtime(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Strip the Windows verbatim prefix (`\\?\C:\...`) that canonicalize
/// returns — Win32 does not normalize forward slashes after it, so the
/// frontend's slash-based path model would break.
fn normalize_local_path_text(text: &str) -> String {
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!("/{}", rest.replace('\\', "/"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.replace('\\', "/")
    } else {
        text.replace('\\', "/")
    }
}

/// Local browsing is scoped to the user's home directory so a compromised
/// webview cannot read or write arbitrary locations.
fn ensure_within_home(path: &Path) -> Result<std::path::PathBuf, String> {
    let home = local_home_dir_path().ok_or("Home directory not found")?;
    let canonical_home = std::fs::canonicalize(&home)
        .map(|path| std::path::PathBuf::from(normalize_local_path_text(&path.to_string_lossy())))
        .unwrap_or_else(|_| home.clone());
    // `..` components would defeat the textual prefix check when
    // canonicalize fails (nonexistent path), so reject them outright.
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Path is outside the home directory".to_string());
    }
    let canonical = std::fs::canonicalize(path)
        .map(|path| std::path::PathBuf::from(normalize_local_path_text(&path.to_string_lossy())))
        .unwrap_or_else(|_| path.to_path_buf());
    if !canonical.starts_with(&canonical_home) {
        return Err("Path is outside the home directory".to_string());
    }
    Ok(canonical)
}

fn local_home_dir_command() -> Result<String, String> {
    let home = local_home_dir_path().ok_or("Home directory not found")?;
    let canonical = std::fs::canonicalize(&home).unwrap_or(home);
    Ok(normalize_local_path_text(&canonical.to_string_lossy()))
}

/// Forward-slash normalized so the frontend breadcrumb model is
/// platform-agnostic (Windows accepts forward slashes in std::fs).
#[tauri::command]
pub async fn local_home_dir() -> Result<String, String> {
    local_home_dir_command()
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<SftpDirEntry>, String> {
    // Windows: a bare drive ("C:") reads the process CWD; make it the root.
    let path = if path.len() == 2 && path.as_bytes()[1] == b':' {
        format!("{}/", path)
    } else {
        path.replace('\\', "/")
    };
    ensure_within_home(Path::new(&path))?;
    let mut read_dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut entries = Vec::new();
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?
    {
        if entries.len() >= MAX_LOCAL_LIST_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let metadata = tokio::fs::metadata(entry.path()).await;
        let (is_dir, size, mtime) = match metadata {
            Ok(metadata) => (metadata.is_dir(), metadata.len(), unix_mtime(&metadata)),
            Err(_) => (false, 0, 0),
        };
        entries.push(SftpDirEntry {
            name,
            is_dir,
            size,
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn local_read_file(path: String) -> Result<SftpFileContent, String> {
    use base64::Engine as _;

    let scoped = ensure_within_home(Path::new(&path))?;
    let metadata = tokio::fs::metadata(&scoped)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    // Regular files only: a FIFO would otherwise block the read loop forever.
    if !metadata.file_type().is_file() {
        return Err("Not a regular file".to_string());
    }
    if metadata.len() > MAX_LOCAL_PREVIEW_READ_BYTES {
        return Err(format!(
            "File is too large to preview ({} bytes exceeds the {} byte limit)",
            metadata.len(),
            MAX_LOCAL_PREVIEW_READ_BYTES
        ));
    }

    let mut file = tokio::fs::File::open(&scoped)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let mut data = Vec::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if read == 0 {
            break;
        }
        if data.len() as u64 + read as u64 > MAX_LOCAL_PREVIEW_READ_BYTES {
            return Err(format!(
                "File exceeded the {} byte preview limit while reading",
                MAX_LOCAL_PREVIEW_READ_BYTES
            ));
        }
        data.extend_from_slice(&buffer[..read]);
    }

    let size = data.len() as u64;
    Ok(SftpFileContent {
        path,
        content_base64: base64::engine::general_purpose::STANDARD.encode(&data),
        size,
    })
}

async fn read_local_file_for_save(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to read file before saving: {}", e))?;
    let mut data = Vec::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file before saving: {}", e))?;
        if read == 0 {
            break;
        }
        if data.len() as u64 + read as u64 > MAX_LOCAL_PREVIEW_READ_BYTES {
            return Err(format!(
                "File exceeded the {} byte save limit while checking for changes",
                MAX_LOCAL_PREVIEW_READ_BYTES
            ));
        }
        data.extend_from_slice(&buffer[..read]);
    }
    Ok(data)
}

#[tauri::command]
pub async fn local_write_file(
    path: String,
    content: String,
    expected_content: String,
) -> Result<(), String> {
    let scoped = ensure_within_home(Path::new(&path))?;
    let _write_guard = crate::FILE_WRITE_LOCK.lock().await;
    let metadata = tokio::fs::metadata(&scoped)
        .await
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !metadata.file_type().is_file() {
        return Err("Not a regular file".to_string());
    }
    if content.len() as u64 > MAX_LOCAL_PREVIEW_READ_BYTES
        || expected_content.len() as u64 > MAX_LOCAL_PREVIEW_READ_BYTES
    {
        return Err(format!(
            "File is too large to save ({} byte limit)",
            MAX_LOCAL_PREVIEW_READ_BYTES
        ));
    }
    let expected_bytes = expected_content.as_bytes();
    if read_local_file_for_save(&scoped).await? != expected_bytes {
        return Err("File changed since it was opened. Reload before saving.".to_string());
    }

    let parent = scoped
        .parent()
        .ok_or_else(|| "File has no parent directory".to_string())?;
    let temp_path = parent.join(format!(".redterm-save-{}.tmp", uuid::Uuid::new_v4()));
    let mut temp_file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temporary save file: {}", e))?;
    let write_result = async {
        temp_file.write_all(content.as_bytes()).await?;
        temp_file.flush().await?;
        temp_file.sync_all().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    drop(temp_file);
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!("Failed to write temporary save file: {}", error));
    }

    let current_content = match read_local_file_for_save(&scoped).await {
        Ok(content) => content,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(error);
        }
    };
    if current_content != expected_bytes {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err("File changed since it was opened. Reload before saving.".to_string());
    }
    let latest_metadata = match tokio::fs::metadata(&scoped).await {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err("Not a regular file".to_string());
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(format!(
                "Failed to read file metadata before saving: {}",
                error
            ));
        }
    };
    let preserve_result = async {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let temp_metadata = tokio::fs::metadata(&temp_path).await?;
            let uid =
                (temp_metadata.uid() != latest_metadata.uid()).then_some(latest_metadata.uid());
            let gid =
                (temp_metadata.gid() != latest_metadata.gid()).then_some(latest_metadata.gid());
            if uid.is_some() || gid.is_some() {
                let owner_path = temp_path.clone();
                tokio::task::spawn_blocking(move || std::os::unix::fs::chown(owner_path, uid, gid))
                    .await
                    .map_err(std::io::Error::other)??;
            }
        }
        tokio::fs::set_permissions(&temp_path, latest_metadata.permissions()).await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(error) = preserve_result {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!("Failed to preserve file metadata: {}", error));
    }
    if let Err(error) = tokio::fs::rename(&temp_path, &scoped).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!("Failed to replace file atomically: {}", error));
    }
    Ok(())
}
async fn copy_with_progress(
    from: &Path,
    destination_file: &mut tokio::fs::File,
    max_bytes: u64,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<u64, String> {
    let mut source = tokio::fs::File::open(from)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let mut buffer = vec![0_u8; 256 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = source
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_bytes {
            return Err(format!("Download exceeded the {} byte limit", max_bytes));
        }
        destination_file
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Failed to write file: {}", e))?;
        on_progress(total);
    }
    destination_file
        .flush()
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(total)
}

async fn local_download(
    app: &AppHandle,
    source: &Path,
    destination_file: &mut tokio::fs::File,
    destination_path: &Path,
    remote_path_label: String,
    max_bytes: u64,
) -> Result<SftpDownloadedFile, String> {
    let total = tokio::fs::metadata(source)
        .await
        .ok()
        .map(|metadata| metadata.len());
    let on_progress = make_download_progress_emitter(app.clone(), remote_path_label.clone(), total);
    let size = copy_with_progress(source, destination_file, max_bytes, &on_progress).await?;
    Ok(SftpDownloadedFile {
        remote_path: remote_path_label,
        local_path: destination_path.to_string_lossy().to_string(),
        size,
    })
}

/// Copy a local file into the preview cache so it can be streamed through
/// the asset protocol (media playback).
#[tauri::command]
pub async fn local_download_file(
    app: AppHandle,
    path: String,
) -> Result<SftpDownloadedFile, String> {
    let scoped = ensure_within_home(Path::new(&path))?;
    if !scoped.is_file() {
        return Err("File not found".to_string());
    }
    let preview_dir = ensure_local_sftp_preview_dir(&app)?;
    let file_name = scoped
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let part_path = preview_dir.join(format!(
        "{}-{}.part",
        uuid::Uuid::new_v4(),
        sanitize_file_name(&file_name)
    ));
    let destination = preview_dir.join(format!(
        "{}-{}",
        uuid::Uuid::new_v4(),
        sanitize_file_name(&file_name)
    ));
    let scoped_label = path.clone();

    let mut part_file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|error| format!("Failed to create preview download file: {error}"))?;
    let downloaded = match local_download(
        &app,
        &scoped,
        &mut part_file,
        &part_path,
        scoped_label,
        MAX_SFTP_PREVIEW_DOWNLOAD_BYTES,
    )
    .await
    {
        Ok(downloaded) => downloaded,
        Err(error) => {
            drop(part_file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(error);
        }
    };
    drop(part_file);
    if let Err(error) = tokio::fs::rename(&part_path, &destination).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!("Failed to finalize preview download: {}", error));
    }

    Ok(SftpDownloadedFile {
        local_path: destination.to_string_lossy().to_string(),
        ..downloaded
    })
}

fn download_file_name(source: &Path, requested: Option<&str>) -> String {
    match requested {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string()),
    }
}

/// Copy a local file or an app-owned preview cache file into a user-chosen
/// directory (defaults to Downloads).
#[tauri::command]
pub async fn local_download_to_dir(
    app: AppHandle,
    path: String,
    destination_path: Option<String>,
) -> Result<SftpDownloadedFile, String> {
    let source = Path::new(&path);
    let scoped = match ensure_within_home(source) {
        Ok(path) => path,
        Err(_) => resolve_sftp_preview_cache_file(&app, source)?
            .ok_or_else(|| "File not found".to_string())?,
    };
    if !scoped.is_file() {
        return Err("File not found".to_string());
    }

    let default_name = download_file_name(&scoped, None);
    let requested = destination_path
        .as_deref()
        .filter(|candidate| !candidate.trim().is_empty());
    let destination_path = match requested {
        Some(path) => std::path::PathBuf::from(path),
        None => {
            let downloads_dir = app
                .path()
                .download_dir()
                .map_err(|e| format!("Failed to resolve Downloads directory: {}", e))?;
            std::fs::create_dir_all(&downloads_dir)
                .map_err(|e| format!("Failed to prepare download directory: {}", e))?;
            downloads_dir.join(&default_name)
        }
    };

    let Some(parent) = destination_path.parent().map(|parent| parent.to_path_buf()) else {
        return Err("Invalid download destination path".to_string());
    };
    let Some(leaf) = destination_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
    else {
        return Err("Invalid download file name".to_string());
    };
    let safe_name = sanitize_file_name(&leaf);
    let mut claimed = claim_download_destination(&parent, &safe_name)?;
    let scoped_label = path.clone();

    match local_download(
        &app,
        &scoped,
        claimed.file_mut(),
        &destination_path,
        scoped_label,
        u64::MAX,
    )
    .await
    {
        Ok(mut downloaded) => {
            downloaded.local_path = claimed.commit().to_string_lossy().into_owned();
            Ok(downloaded)
        }
        Err(error) => {
            let cleanup = claimed.discard();
            Err(append_cleanup_error(error, cleanup))
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn requested_download_file_name_preserves_whitespace() {
        let source = Path::new("/tmp/cache-preview");
        assert_eq!(
            download_file_name(source, Some(" report.txt ")),
            " report.txt "
        );
        assert_eq!(download_file_name(source, None), "cache-preview");
    }

    #[test]
    fn local_shell_sets_supported_terminal_type() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open test PTY");
        let mut command = CommandBuilder::new("/usr/bin/env");
        configure_local_shell_command(&mut command);
        let mut reader = pair.master.try_clone_reader().expect("attach test reader");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn test command");
        drop(pair.slave);

        let mut output = String::new();
        reader
            .read_to_string(&mut output)
            .expect("read test output");
        child.wait().expect("wait for test command");
        assert!(output
            .lines()
            .any(|line| line.trim_end() == "TERM=xterm-256color"));
        assert!(!output.lines().any(|line| line.starts_with("HERDR_")));
    }

    #[test]
    fn parent_terminal_session_env_key_matches_only_herdr_prefix() {
        assert!(is_parent_terminal_session_env_key(std::ffi::OsStr::new(
            "HERDR_ENV"
        )));
        assert!(is_parent_terminal_session_env_key(std::ffi::OsStr::new(
            "herdr_socket_path"
        )));
        assert!(!is_parent_terminal_session_env_key(std::ffi::OsStr::new(
            "HERDR"
        )));
        assert!(!is_parent_terminal_session_env_key(std::ffi::OsStr::new(
            "PATH"
        )));
    }

    #[test]
    fn recent_output_enforces_chunk_and_byte_limits() {
        let mut output = LocalRecentOutput::default();
        for seq in 1..=(MAX_RECENT_LOCAL_CHUNK_COUNT as u64 + 1) {
            output.push(LocalShellDataChunk { seq, data: vec![0] });
        }
        assert_eq!(output.chunks.len(), MAX_RECENT_LOCAL_CHUNK_COUNT);
        assert_eq!(output.chunks.front().map(|chunk| chunk.seq), Some(2));

        let mut byte_limited = LocalRecentOutput::default();
        byte_limited.push(LocalShellDataChunk {
            seq: 1,
            data: vec![0; 3 * 1024 * 1024],
        });
        byte_limited.push(LocalShellDataChunk {
            seq: 2,
            data: vec![1; 3 * 1024 * 1024],
        });
        assert_eq!(byte_limited.chunks.len(), 1);
        assert_eq!(byte_limited.total_bytes, 3 * 1024 * 1024);
    }

    #[test]
    fn recent_output_rejects_sequence_gaps_and_returns_newer_chunks() {
        let mut output = LocalRecentOutput::default();
        output.push(LocalShellDataChunk {
            seq: 3,
            data: vec![3],
        });
        output.push(LocalShellDataChunk {
            seq: 4,
            data: vec![4],
        });

        assert!(output.chunks_after(1, 4).is_err());
        let chunks = output.chunks_after(3, 4).expect("covered replay range");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].seq, 4);
        assert_eq!(chunks[0].data, vec![4]);
    }

    #[test]
    fn recent_output_assigns_monotonic_sequences_with_the_history_update() {
        let mut output = LocalRecentOutput::default();
        let first = output.push_data(vec![1]);
        let second = output.push_data(vec![2]);

        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);
        assert_eq!(output.last_seq, 2);
        let replay = output
            .chunks_after(0, output.last_seq)
            .expect("complete replay range");
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0].seq, first.seq);
        assert_eq!(replay[0].data, first.data);
        assert_eq!(replay[1].seq, second.seq);
        assert_eq!(replay[1].data, second.data);
    }
    #[tokio::test]
    async fn local_write_rejects_stale_content_without_overwriting() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(
            ".redterm-save-conflict-test-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&path, b"original")
            .await
            .expect("create test file");
        let path_text = path.to_string_lossy().to_string();

        let error = local_write_file(path_text.clone(), "mine".to_string(), "stale".to_string())
            .await
            .expect_err("stale save must fail");
        assert_eq!(
            error,
            "File changed since it was opened. Reload before saving."
        );
        assert_eq!(
            tokio::fs::read(&path).await.expect("read unchanged file"),
            b"original"
        );

        local_write_file(path_text, "mine".to_string(), "original".to_string())
            .await
            .expect("save unchanged file");
        assert_eq!(
            tokio::fs::read(&path).await.expect("read saved file"),
            b"mine"
        );
        tokio::fs::remove_file(&path)
            .await
            .expect("remove test file");
    }
    #[tokio::test]
    async fn concurrent_local_writes_allow_only_one_shared_baseline() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(
            ".redterm-concurrent-save-test-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&path, b"original")
            .await
            .expect("create test file");
        let path_text = path.to_string_lossy().to_string();

        let first = local_write_file(
            path_text.clone(),
            "first".to_string(),
            "original".to_string(),
        );
        let second = local_write_file(path_text, "second".to_string(), "original".to_string());
        let (first_result, second_result) = tokio::join!(first, second);

        assert_ne!(first_result.is_ok(), second_result.is_ok());
        let expected: &[u8] = if first_result.is_ok() {
            b"first"
        } else {
            b"second"
        };
        assert_eq!(
            tokio::fs::read(&path).await.expect("read winning save"),
            expected
        );
        let conflict = first_result.err().or_else(|| second_result.err());
        assert_eq!(
            conflict.as_deref(),
            Some("File changed since it was opened. Reload before saving.")
        );
        tokio::fs::remove_file(&path)
            .await
            .expect("remove test file");
    }
}

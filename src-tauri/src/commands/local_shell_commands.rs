use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, RwLock};

use super::ssh_commands::{
    append_cleanup_error, claim_download_destination, create_private_preview_file,
    ensure_local_sftp_preview_dir, make_download_progress_emitter, make_remove_progress_emitter,
    resolve_sftp_preview_cache_file, sanitize_file_name, RemoveOrigin, SftpDownloadedFile,
    SftpFileContent, MAX_SFTP_PREVIEW_DOWNLOAD_BYTES,
};
use crate::ssh::{RemovePhase, RemoveProgress, SftpDirEntry};

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

#[cfg(not(windows))]
fn local_version_from_metadata(metadata: &std::fs::Metadata) -> Option<String> {
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Some(format!(
            "{}:{}:{}:{}:{}:{}",
            metadata.len(),
            modified.as_nanos(),
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        ));
    }
    #[cfg(not(unix))]
    {
        Some(format!("{}:{}", metadata.len(), modified.as_nanos()))
    }
}

#[cfg(windows)]
fn windows_local_file_identity(file: &tokio::fs::File) -> Option<(u32, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.ok()?;
    Some((
        info.dwVolumeSerialNumber,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}

#[cfg(windows)]
fn windows_local_version_from_file(
    file: &tokio::fs::File,
    metadata: &std::fs::Metadata,
) -> Option<String> {
    use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
    };

    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    // Both the timestamp/size and identity must describe the open file, not a
    // path that could have been atomically replaced between independent stats.
    let (volume, file_index) = windows_local_file_identity(file)?;
    let mut basic_info = FILE_BASIC_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileBasicInfo,
            (&raw mut basic_info).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    }
    .ok()?;
    // The same open file supplies metadata, identity, and ChangeTime.
    // LastWriteTime can be restored after an in-place edit. ChangeTime tracks
    // that metadata update even when the length and content timestamp match.
    Some(format!(
        "{}:{}:{}:{}:{}:{}",
        metadata.len(),
        modified.as_nanos(),
        metadata.creation_time(),
        volume,
        file_index,
        basic_info.ChangeTime
    ))
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

fn validate_local_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("Invalid file name".to_string());
    }
    Ok(())
}

/// Scope a create/delete target by validating its leaf name and requiring the
/// (existing) parent to be inside the home directory. Validating the parent
/// instead of the full path keeps a symlinked parent from escaping home on
/// create and lets deletes operate on the link itself rather than its target.
///
/// Known residual race (same class as the documented download-destination
/// limitation): a same-uid process renaming the validated parent into a
/// symlink between this check and the mutation could redirect it. A local
/// same-uid process is outside the webview threat model these guards exist
/// for; pinning a parent directory handle (openat on Unix, handles on
/// Windows) is the recorded hardening task if that ever changes.
fn ensure_within_home_entry(path: &Path) -> Result<std::path::PathBuf, String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("Invalid path")?;
    let leaf = path.file_name().ok_or("Invalid path")?;
    validate_local_entry_name(&leaf.to_string_lossy())?;
    let scoped_parent = ensure_within_home(parent)?;
    Ok(scoped_parent.join(leaf))
}

#[tauri::command]
pub async fn local_create_dir(path: String) -> Result<(), String> {
    let scoped = ensure_within_home_entry(Path::new(&path))?;
    if tokio::fs::symlink_metadata(&scoped).await.is_ok() {
        return Err("Path already exists".to_string());
    }
    tokio::fs::create_dir(&scoped)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_create_file(path: String) -> Result<(), String> {
    let scoped = ensure_within_home_entry(Path::new(&path))?;
    if tokio::fs::symlink_metadata(&scoped).await.is_ok() {
        return Err("Path already exists".to_string());
    }
    tokio::fs::File::create_new(&scoped)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn local_remove_path(
    app: AppHandle,
    path: String,
    origin_id: String,
) -> Result<(), String> {
    let scoped = ensure_within_home_entry(Path::new(&path))?;
    let metadata = tokio::fs::symlink_metadata(&scoped)
        .await
        .map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return tokio::fs::remove_file(&scoped)
            .await
            .map_err(|e| e.to_string());
    }
    // The emitter label uses the caller-facing path; deletion itself uses the
    // scoped path resolved above.
    let on_progress = make_remove_progress_emitter(app, path, RemoveOrigin { origin_id });
    remove_dir_all_with_progress(&scoped, &on_progress).await
}

/// Collect the local tree, unlink files, then remove directories in reverse
/// discovery order while reporting completed entries. Symlinks are unlinked
/// rather than traversed. Remote deletion supports only files and empty folders.
async fn remove_dir_all_with_progress(
    root: &Path,
    on_progress: &impl Fn(RemoveProgress),
) -> Result<(), String> {
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut queue = vec![root.to_path_buf()];
    while let Some(dir) = queue.pop() {
        dirs.push(dir.clone());
        on_progress(RemoveProgress {
            phase: RemovePhase::Scanning,
            deleted: 0,
            total: None,
            current: display_leaf(&dir),
        });
        let mut reader = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
        while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
            let child = entry.path();
            // DirEntry::file_type does not follow symlinks.
            let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                queue.push(child);
            } else if is_dir_link(&file_type) {
                dirs.push(child);
            } else {
                files.push(child);
            }
        }
    }
    let total = files.len() + dirs.len();
    let mut deleted = 0usize;
    for file in &files {
        tokio::fs::remove_file(file)
            .await
            .map_err(|e| e.to_string())?;
        deleted += 1;
        on_progress(RemoveProgress {
            phase: RemovePhase::Deleting,
            deleted,
            total: Some(total),
            current: display_leaf(file),
        });
    }
    for dir in dirs.iter().rev() {
        tokio::fs::remove_dir(dir)
            .await
            .map_err(|e| e.to_string())?;
        deleted += 1;
        on_progress(RemoveProgress {
            phase: RemovePhase::Deleting,
            deleted,
            total: Some(total),
            current: display_leaf(dir),
        });
    }
    Ok(())
}

/// Windows-only: directory symlinks and junctions report `is_dir() == false`
/// from `DirEntry::file_type` (like any symlink), and `remove_file` cannot
/// unlink them — they must go through `remove_dir`, which removes the
/// reparse point itself without touching the target. `is_symlink_dir`
/// classifies both from the entry's file type, no extra stat needed.
#[cfg(windows)]
fn is_dir_link(file_type: &std::fs::FileType) -> bool {
    use std::os::windows::fs::FileTypeExt;
    file_type.is_symlink_dir()
}

#[cfg(not(windows))]
fn is_dir_link(_file_type: &std::fs::FileType) -> bool {
    // Unix directory symlinks are unlinked as files, matching the SSH path's
    // LSTAT semantics.
    false
}

fn display_leaf(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
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
            return Err(format!(
                "Local directory contains more than {MAX_LOCAL_LIST_ENTRIES} entries; listing was not loaded"
            ));
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
pub async fn local_file_version(path: String) -> Result<Option<String>, String> {
    let scoped = ensure_within_home(Path::new(&path))?;
    let metadata = tokio::fs::metadata(&scoped)
        .await
        .map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Not a regular file".to_string());
    }
    #[cfg(windows)]
    {
        let file = tokio::fs::File::open(&scoped)
            .await
            .map_err(|e| e.to_string())?;
        let opened_metadata = file.metadata().await.map_err(|e| e.to_string())?;
        if !opened_metadata.is_file() {
            return Err("Not a regular file".to_string());
        }
        Ok(windows_local_version_from_file(&file, &opened_metadata))
    }
    #[cfg(not(windows))]
    {
        Ok(local_version_from_metadata(&metadata))
    }
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
    #[cfg(windows)]
    let version = {
        let opened_metadata = file
            .metadata()
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if !opened_metadata.is_file() {
            return Err("Not a regular file".to_string());
        }
        if opened_metadata.len() > MAX_LOCAL_PREVIEW_READ_BYTES {
            return Err(format!(
                "File is too large to preview ({} bytes exceeds the {} byte limit)",
                opened_metadata.len(),
                MAX_LOCAL_PREVIEW_READ_BYTES
            ));
        }
        windows_local_version_from_file(&file, &opened_metadata)
    };
    #[cfg(not(windows))]
    let version = local_version_from_metadata(&metadata);
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
        version,
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
#[cfg(target_os = "macos")]
fn copy_local_save_attributes(
    source: &std::fs::File,
    staged: &std::fs::File,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn acl_init(count: libc::c_int) -> *mut libc::c_void;
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
        fn acl_set_fd_np(fd: libc::c_int, acl: *mut libc::c_void, kind: libc::c_int)
            -> libc::c_int;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
    }
    const ACL_TYPE_EXTENDED: libc::c_int = 0x100;
    let original_acl = unsafe { acl_get_fd_np(source.as_raw_fd(), ACL_TYPE_EXTENDED) };
    let acl = if original_acl.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOENT) {
            return Err(error);
        }
        // A new inode may inherit a parent ACL even if the original has none.
        unsafe { acl_init(0) }
    } else {
        original_acl
    };
    if acl.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let result = unsafe { acl_set_fd_np(staged.as_raw_fd(), acl, ACL_TYPE_EXTENDED) };
    let error = (result == -1).then(std::io::Error::last_os_error);
    unsafe { acl_free(acl) };
    if let Some(error) = error {
        return Err(error);
    }
    // fcopyfile's ACL option drops inherited entries. The native ACL copy
    // above retains them; use fcopyfile only for xattrs and resource forks.
    let result = unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            staged.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_XATTR,
        )
    };
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn list_local_save_attributes(fd: libc::c_int) -> std::io::Result<Vec<std::ffi::CString>> {
    let length = unsafe { libc::flistxattr(fd, std::ptr::null_mut(), 0) };
    if length < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut names = vec![0u8; length as usize];
    let actual = unsafe { libc::flistxattr(fd, names.as_mut_ptr().cast(), names.len()) };
    if actual < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if actual as usize != names.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "xattr names changed while copying",
        ));
    }
    names
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| {
            std::ffi::CString::new(name)
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn copy_local_save_attributes(
    source: &std::fs::File,
    staged: &std::fs::File,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let from = source.as_raw_fd();
    let to = staged.as_raw_fd();
    let source_names = list_local_save_attributes(from)?;
    // POSIX access ACLs can be inherited from the parent on creation. Remove
    // every attribute absent from the source before copying source attributes.
    for name in list_local_save_attributes(to)? {
        if !source_names.iter().any(|original| original == &name)
            && unsafe { libc::fremovexattr(to, name.as_ptr()) } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    for name in source_names {
        let len = unsafe { libc::fgetxattr(from, name.as_ptr(), std::ptr::null_mut(), 0) };
        if len < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut value = vec![0u8; len as usize];
        let actual =
            unsafe { libc::fgetxattr(from, name.as_ptr(), value.as_mut_ptr().cast(), value.len()) };
        if actual < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if actual as usize != value.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "xattr value changed while copying",
            ));
        }
        if unsafe { libc::fsetxattr(to, name.as_ptr(), value.as_ptr().cast(), value.len(), 0) } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn copy_local_save_attributes(_: &std::fs::File, _: &std::fs::File) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "cannot preserve ACLs and xattrs on this platform",
    ))
}

#[cfg(windows)]
fn copy_local_save_attributes(
    source: &std::fs::File,
    staged: &std::fs::File,
) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        EqualSid, GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION,
        GROUP_SECURITY_INFORMATION, OBJECT_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
        UNPROTECTED_DACL_SECURITY_INFORMATION,
    };

    struct SecurityInfo {
        descriptor: PSECURITY_DESCRIPTOR,
        owner: PSID,
        group: PSID,
        acl: *mut ACL,
    }
    impl SecurityInfo {
        fn read(handle: HANDLE) -> std::io::Result<Self> {
            let mut info = Self {
                descriptor: PSECURITY_DESCRIPTOR::default(),
                owner: PSID::default(),
                group: PSID::default(),
                acl: std::ptr::null_mut(),
            };
            let flags = OBJECT_SECURITY_INFORMATION(
                OWNER_SECURITY_INFORMATION.0
                    | GROUP_SECURITY_INFORMATION.0
                    | DACL_SECURITY_INFORMATION.0,
            );
            let status = unsafe {
                GetSecurityInfo(
                    handle,
                    SE_FILE_OBJECT,
                    flags,
                    Some(&mut info.owner),
                    Some(&mut info.group),
                    Some(&mut info.acl),
                    None,
                    Some(&mut info.descriptor),
                )
            };
            if status != ERROR_SUCCESS {
                return Err(std::io::Error::from_raw_os_error(status.0 as i32));
            }
            Ok(info)
        }
        fn protected(&self) -> std::io::Result<bool> {
            let mut control = 0u16;
            let mut revision = 0u32;
            unsafe { GetSecurityDescriptorControl(self.descriptor, &mut control, &mut revision) }
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            Ok(control & SE_DACL_PROTECTED.0 != 0)
        }
        fn acl_bytes(&self) -> Option<&[u8]> {
            if self.acl.is_null() {
                return None;
            }
            // GetSecurityInfo owns the ACL buffer until this descriptor is dropped.
            let size = unsafe { (*self.acl).AclSize as usize };
            Some(unsafe { std::slice::from_raw_parts(self.acl.cast::<u8>(), size) })
        }
    }
    impl Drop for SecurityInfo {
        fn drop(&mut self) {
            if !self.descriptor.0.is_null() {
                unsafe {
                    LocalFree(Some(HLOCAL(self.descriptor.0)));
                }
            }
        }
    }
    fn same_sid(a: PSID, b: PSID) -> bool {
        if a.is_invalid() || b.is_invalid() {
            a == b
        } else {
            unsafe { EqualSid(a, b).is_ok() }
        }
    }

    let staged_handle = HANDLE(staged.as_raw_handle());
    let original = SecurityInfo::read(HANDLE(source.as_raw_handle()))?;
    let before = SecurityInfo::read(staged_handle)?;
    if !same_sid(original.owner, before.owner) || !same_sid(original.group, before.group) {
        // Changing owner/group requires WRITE_OWNER or a privilege. Never
        // publish a replacement that changes the source's ownership instead.
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "cannot preserve file owner or group on the staged file",
        ));
    }
    let protection = if original.protected()? {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let flags = OBJECT_SECURITY_INFORMATION(DACL_SECURITY_INFORMATION.0 | protection.0);
    let status = unsafe {
        SetSecurityInfo(
            staged_handle,
            SE_FILE_OBJECT,
            flags,
            None,
            None,
            Some(original.acl),
            None,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(status.0 as i32));
    }
    // Unprotected ACLs can be combined with inherited parent ACEs by the OS.
    // Check the resulting full DACL (including inherited ACE flags), not just
    // the SetSecurityInfo success code, before any new bytes are written.
    let actual = SecurityInfo::read(staged_handle)?;
    if actual.protected()? != original.protected()?
        || !same_sid(original.owner, actual.owner)
        || !same_sid(original.group, actual.group)
        || actual.acl_bytes() != original.acl_bytes()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "staged file security descriptor differs from original",
        ));
    }
    Ok(())
}

fn preserve_local_save_metadata(
    source: &std::fs::File,
    staged: &std::fs::File,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let original = source.metadata()?;
        let temporary = staged.metadata()?;
        if temporary.uid() != original.uid() || temporary.gid() != original.gid() {
            use std::os::fd::AsRawFd;
            let uid = (temporary.uid() != original.uid())
                .then_some(original.uid())
                .unwrap_or(!0);
            let gid = (temporary.gid() != original.gid())
                .then_some(original.gid())
                .unwrap_or(!0);
            if unsafe { libc::fchown(staged.as_raw_fd(), uid, gid) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        staged.set_permissions(std::fs::Permissions::from_mode(original.mode()))?;
    }
    #[cfg(windows)]
    staged.set_permissions(source.metadata()?.permissions())?;
    copy_local_save_attributes(source, staged)
}

#[cfg(target_os = "macos")]
fn local_save_directory_has_unsafe_acl(directory: &Path) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
        fn acl_to_text(acl: *mut libc::c_void, length: *mut isize) -> *mut libc::c_char;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
    }
    let handle = std::fs::File::open(directory)?;
    let acl = unsafe { acl_get_fd_np(handle.as_raw_fd(), 0x100) };
    if acl.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(false)
        } else {
            Err(error)
        };
    }
    let mut length = 0;
    let text = unsafe { acl_to_text(acl, &mut length) };
    if text.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe { acl_free(acl) };
        return Err(error);
    }
    let bytes = unsafe { std::slice::from_raw_parts(text.cast::<u8>(), length as usize) };
    // Denials and read-only inherited ACLs cannot rename our stage. Reject
    // any unrecognized grant rather than assume it cannot allow delete_child.
    let safe = std::str::from_utf8(bytes).is_ok_and(|text| {
        text.lines().all(|line| {
            if line.starts_with("!#acl") {
                return true;
            }
            let Some((prefix, permissions)) = line.rsplit_once(':') else {
                return false;
            };
            let Some((_, policy)) = prefix.rsplit_once(':') else {
                return false;
            };
            if policy.split(',').next() == Some("deny") {
                return true;
            }
            if policy.split(',').next() != Some("allow") {
                return false;
            }
            permissions.split(',').all(|permission| {
                matches!(
                    permission,
                    "read"
                        | "list"
                        | "search"
                        | "execute"
                        | "readattr"
                        | "readextattr"
                        | "readsecurity"
                        | "file_inherit"
                        | "directory_inherit"
                )
            })
        })
    });
    unsafe {
        acl_free(text.cast());
        acl_free(acl)
    };
    Ok(!safe)
}

#[cfg(unix)]
fn ensure_local_save_parent_protected(parent: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::geteuid() };
    for directory in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(directory)
            .map_err(|error| format!("Failed to verify save directory: {error}"))?;
        if !metadata.file_type().is_dir()
            || (metadata.uid() != uid && metadata.uid() != 0)
            || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
        {
            return Err(
                "Save copy requires a private or trusted sticky directory for every ancestor"
                    .to_string(),
            );
        }
        #[cfg(target_os = "macos")]
        if local_save_directory_has_unsafe_acl(directory)
            .map_err(|error| format!("Failed to verify save directory ACL: {error}"))?
        {
            return Err("Save copy directory ACL cannot be verified as private".to_string());
        }
    }
    Ok(())
}

async fn create_local_save_file(path: &Path) -> std::io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    #[cfg(windows)]
    {
        // SetSecurityInfo needs WRITE_DAC on the SAME handle that was created.
        // Deny delete/write sharing so another process cannot swap the stage.
        options.access_mode(0x4000_0000 | 0x0004_0000 | 0x0002_0000 | 0x0000_0080 | 0x0000_0100);
        options.share_mode(0x0000_0001);
    }
    options.open(path).await
}

// Called only before publication; a published revision is never a cleanup target.
async fn cleanup_unpublished_local_save(path: &Path, error: String) -> String {
    match tokio::fs::remove_file(path).await {
        Ok(()) => error,
        Err(cleanup) => format!(
            "{error}; failed to remove temporary save file {}: {cleanup}",
            path.display()
        ),
    }
}
// Keep the origin recognizable and its extension usable in the file explorer.
// A UUID prevents two saves (including saves by different processes) from
// choosing the same revision name; hard_link below is the no-replace gate.
fn local_save_copy_name(path: &Path) -> Result<String, String> {
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "File name cannot be used for a saved copy".to_string())?;
    // The editor retargets to every saved copy. Remove only the final marker
    // that this command emitted, so its name never grows with repeated saves.
    let stem = stem
        .rsplit_once(".redterm-")
        .filter(|(origin, id)| {
            !origin.is_empty() && id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()
        })
        .map_or(stem, |(origin, _)| origin);
    let extension = path
        .extension()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let suffix = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    let marker = format!(".redterm-{}", uuid::Uuid::new_v4());
    // Common file systems allow 255-byte leaf names. Leave headroom rather
    // than making an otherwise valid long source name impossible to save.
    let stem_limit = 240usize
        .checked_sub(marker.len() + suffix.len())
        .ok_or_else(|| "File extension is too long for a saved copy".to_string())?;
    let mut end = stem.len().min(stem_limit);
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        return Err("File name is too long for a saved copy".to_string());
    }
    Ok(format!("{}{marker}{suffix}", &stem[..end]))
}
#[tauri::command]
pub async fn local_save_copy(
    path: String,
    content: String,
    expected_content: String,
) -> Result<crate::SavedFileCopy, String> {
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
    #[cfg(unix)]
    ensure_local_save_parent_protected(parent)?;
    let copy_path = parent.join(local_save_copy_name(&scoped)?);
    let temp_path = parent.join(format!(".redterm-save-{}.tmp", uuid::Uuid::new_v4()));
    // On Unix, stage privately from creation, before restoring the original metadata.
    let mut temp_file = create_local_save_file(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temporary save file: {}", e))?;
    // Transfer the existing file's security metadata while the staged file is
    // still empty. In particular, a Windows temp inherits its parent DACL;
    // writing first could expose new bytes under the wrong ACL.
    let source_path = scoped.clone();
    let staged_handle = temp_file
        .try_clone()
        .await
        .map_err(|error| format!("Failed to retain staged file handle: {error}"))?
        .into_std()
        .await;
    let preserve_result = tokio::task::spawn_blocking(move || {
        let source = std::fs::File::open(&source_path)?;
        if !source.metadata()?.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Not a regular file",
            ));
        }
        let staged = staged_handle;
        preserve_local_save_metadata(&source, &staged)
    })
    .await
    .map_err(std::io::Error::other)
    .and_then(|result| result);
    if let Err(error) = preserve_result {
        drop(temp_file);
        return Err(cleanup_unpublished_local_save(
            &temp_path,
            format!("Failed to preserve file metadata: {}", error),
        )
        .await);
    }

    let write_result = async {
        temp_file.write_all(content.as_bytes()).await?;
        temp_file.flush().await?;
        temp_file.sync_all().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(error) = write_result {
        drop(temp_file);
        return Err(cleanup_unpublished_local_save(
            &temp_path,
            format!("Failed to write temporary save file: {}", error),
        )
        .await);
    }

    let current_content = match read_local_file_for_save(&scoped).await {
        Ok(content) => content,
        Err(error) => {
            drop(temp_file);
            return Err(cleanup_unpublished_local_save(&temp_path, error).await);
        }
    };
    if current_content != expected_bytes {
        drop(temp_file);
        return Err(cleanup_unpublished_local_save(
            &temp_path,
            "File changed since it was opened. Reload before saving.".to_string(),
        )
        .await);
    }

    // Link, never rename over the source or another revision. The exclusive
    // destination creation refuses a colliding name instead of overwriting it.
    // Keep the staged handle to identify our inode even if a path is swapped.
    if let Err(error) = tokio::fs::hard_link(&temp_path, &copy_path).await {
        drop(temp_file);
        return Err(cleanup_unpublished_local_save(
            &temp_path,
            format!("Failed to publish saved copy: {}", error),
        )
        .await);
    }
    // Once published, NEVER delete copy_path: it contains the saved revision.
    // Windows denies unlink while the staged handle is open. Retain its volume
    // and file index, then read ChangeTime from the final name after unlink;
    // removing a hard link may change the revision on either OS.
    #[cfg(windows)]
    let published_identity = windows_local_file_identity(&temp_file);
    #[cfg(windows)]
    drop(temp_file);
    let cleanup = tokio::fs::remove_file(&temp_path).await;
    #[cfg(not(windows))]
    let version = temp_file
        .metadata()
        .await
        .ok()
        .filter(|m| m.is_file())
        .as_ref()
        .and_then(local_version_from_metadata);
    #[cfg(not(windows))]
    drop(temp_file);
    cleanup.map_err(|error| {
        format!(
            "Saved copy at {} but failed to remove temporary link: {}",
            copy_path.display(),
            error
        )
    })?;
    #[cfg(windows)]
    let version = {
        let expected = published_identity.ok_or_else(|| {
            format!(
                "Saved copy at {} but could not identify the published file",
                copy_path.display()
            )
        })?;
        let published = tokio::fs::File::open(&copy_path).await.map_err(|error| {
            format!(
                "Saved copy at {} but could not reopen it: {error}",
                copy_path.display()
            )
        })?;
        if windows_local_file_identity(&published) != Some(expected) {
            return Err(format!(
                "Saved copy at {} but its identity changed",
                copy_path.display()
            ));
        }
        let metadata = published.metadata().await.map_err(|error| {
            format!(
                "Saved copy at {} but could not inspect it: {error}",
                copy_path.display()
            )
        })?;
        if !metadata.is_file() {
            return Err(format!(
                "Saved copy at {} is not a regular file",
                copy_path.display()
            ));
        }
        windows_local_version_from_file(&published, &metadata)
    };
    Ok(crate::SavedFileCopy {
        path: copy_path.to_string_lossy().into_owned(),
        version,
    })
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
    let on_progress =
        make_download_progress_emitter(app.clone(), remote_path_label.clone(), total, None);
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

    let mut part_file = create_private_preview_file(&part_path).await?;
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

/// Copy a home-scoped folder into a user-selected parent directory. The copy
/// engine claims a new root rather than merging with an existing folder and
/// rolls back only the entries it created if any source entry cannot be copied.
#[derive(Default)]
struct FolderCopyProgress {
    file_index: usize,
    completed: u64,
    current: u64,
}

impl FolderCopyProgress {
    fn update(&mut self, progress: &crate::ssh::UploadProgress) -> u64 {
        if progress.file_index != self.file_index {
            self.completed = self.completed.saturating_add(self.current);
            self.file_index = progress.file_index;
        }
        self.current = progress.transferred;
        self.completed.saturating_add(self.current)
    }
}

#[tauri::command]
pub async fn local_download_folder(
    app: AppHandle,
    path: String,
    destination_path: String,
    origin_id: String,
) -> Result<SftpDownloadedFile, String> {
    let on_progress =
        make_download_progress_emitter(app.clone(), path.clone(), None, Some(origin_id.clone()));
    let state = Mutex::new(FolderCopyProgress::default());
    let result = copy_home_folder(path.clone(), destination_path, move |progress| {
        let transferred = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .update(&progress);
        on_progress(transferred);
    })
    .await?;
    make_download_progress_emitter(app, path, Some(result.size), Some(origin_id))(result.size);
    Ok(result)
}

async fn copy_home_folder(
    path: String,
    destination_path: String,
    on_progress: impl Fn(crate::ssh::UploadProgress) + Send + Sync + 'static,
) -> Result<SftpDownloadedFile, String> {
    use crate::ssh::UploadSelectionKind;

    let source = std::path::PathBuf::from(&path);
    let scoped = ensure_within_home(&source)?;
    if !scoped.is_dir() {
        return Err("Folder not found".to_string());
    }
    if destination_path.trim().is_empty() {
        return Err("Copy destination is required".to_string());
    }
    let destination = std::path::PathBuf::from(destination_path);
    tauri::async_runtime::spawn_blocking(move || {
        // Recheck the home boundary after scheduling. The source leaf's no-follow
        // open rejects a symlinked folder even if the picker path changed.
        ensure_within_home(&source)?;
        let copied = crate::storage::local_upload::copy_upload_paths(
            &destination,
            vec![source],
            UploadSelectionKind::Folder,
            &on_progress,
        )?;
        if let Some(failure) = copied.failed.into_iter().next() {
            return Err(failure.error);
        }
        let folder = copied
            .uploaded
            .into_iter()
            .next()
            .ok_or_else(|| "Folder was not copied".to_string())?;
        Ok(SftpDownloadedFile {
            remote_path: path,
            local_path: folder.remote_path,
            size: folder.size,
        })
    })
    .await
    .map_err(|error| format!("Failed to copy folder: {error}"))?
}

#[tauri::command]
pub async fn local_upload(
    app: AppHandle,
    session_id: String,
    path: String,
    selection_kind: String,
    origin_id: String,
) -> Result<Option<crate::ssh::SftpUploadResult>, String> {
    use super::ssh_commands::{emit_upload_progress, pick_upload_paths};
    use crate::ssh::UploadSelectionKind;

    let kind = UploadSelectionKind::parse(&selection_kind)?;
    if origin_id.is_empty() {
        return Err("Copy origin is required".to_string());
    }
    let destination = std::path::PathBuf::from(path);
    let scoped = ensure_within_home(&destination)?;
    if !scoped.is_dir() {
        return Err("Copy destination is not a directory".to_string());
    }
    let title = match kind {
        UploadSelectionKind::Files => "Copy files",
        UploadSelectionKind::Folder => "Copy folder",
    };
    let Some(paths) = pick_upload_paths(&app, kind, title).await? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        // The picker can remain open while the filesystem changes. Recheck
        // the home boundary, but pin the original path through the no-follow copy engine.
        ensure_within_home(&destination)?;
        crate::storage::local_upload::copy_upload_paths(&destination, paths, kind, &|progress| {
            emit_upload_progress(&app, &origin_id, &session_id, progress);
        })
    })
    .await
    .map_err(|error| format!("Failed to copy selected items: {error}"))?
    .map(Some)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_folder_download_keeps_existing_data_and_rejects_links() {
        use std::os::unix::fs::symlink;

        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let home = local_home_dir_path().expect("test home directory");
        let root = home.join(format!(
            ".redterm-folder-download-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let fixture = Fixture(root);
        let source = fixture.0.join("source");
        let downloads = fixture.0.join("downloads");
        std::fs::create_dir_all(source.join("inner/empty")).unwrap();
        std::fs::create_dir_all(downloads.join("source")).unwrap();
        std::fs::write(source.join("payload"), b"folder bytes").unwrap();
        std::fs::write(source.join("inner/second"), b"more").unwrap();
        std::fs::write(downloads.join("source/keep"), b"old bytes").unwrap();
        let label = source.to_string_lossy().into_owned();
        let parent = downloads.to_string_lossy().into_owned();
        let progress = Arc::new(Mutex::new((FolderCopyProgress::default(), Vec::new())));
        let seen = Arc::clone(&progress);
        let copied = copy_home_folder(label.clone(), parent.clone(), move |event| {
            let mut state = seen.lock().unwrap();
            let transferred = state.0.update(&event);
            state.1.push(transferred);
        })
        .await
        .unwrap();
        assert_eq!(copied.remote_path, label);
        assert_eq!(
            copied.local_path,
            downloads.join("source (1)").to_string_lossy()
        );
        assert_eq!(copied.size, 16);
        let samples = progress.lock().unwrap();
        assert_eq!(samples.1.last(), Some(&16));
        assert!(samples.1.windows(2).all(|pair| pair[1] >= pair[0]));
        assert_eq!(
            std::fs::read(downloads.join("source/keep")).unwrap(),
            b"old bytes"
        );
        assert_eq!(
            std::fs::read(downloads.join("source (1)/payload")).unwrap(),
            b"folder bytes"
        );
        assert!(downloads.join("source (1)/inner/empty").is_dir());

        symlink(&downloads, source.join("inner/link")).unwrap();
        assert!(
            copy_home_folder(label.clone(), parent.clone(), |_| {})
                .await
                .is_err(),
            "a linked descendant cannot be copied"
        );
        assert!(!downloads.join("source (2)").exists());
        std::fs::remove_file(source.join("inner/link")).unwrap();
        let source_link = fixture.0.join("linked-source");
        symlink(&source, &source_link).unwrap();
        assert!(
            copy_home_folder(source_link.to_string_lossy().into_owned(), parent, |_| {})
                .await
                .is_err(),
            "a linked source cannot be copied"
        );
        assert!(!downloads.join("linked-source").exists());

        let nested = source.join("inner");
        let into_self = copy_home_folder(label, nested.to_string_lossy().into_owned(), |_| {})
            .await
            .unwrap();
        assert_eq!(
            into_self.local_path,
            nested.join("source").to_string_lossy()
        );
        assert!(nested.join("source/inner/empty").is_dir());
        assert_eq!(
            std::fs::read(nested.join("source/payload")).unwrap(),
            b"folder bytes"
        );
        assert!(!nested.join("source/inner/source").exists());
    }

    #[tokio::test]
    async fn local_directory_over_limit_fails_instead_of_hiding_unlisted_files() {
        struct TestDirectory(std::path::PathBuf);
        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let home = local_home_dir_path().expect("test home directory");
        let root = home.join(format!(".redterm-list-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let fixture = TestDirectory(root);
        for index in 0..MAX_LOCAL_LIST_ENTRIES {
            std::fs::File::create(fixture.0.join(format!("{index:05}"))).unwrap();
        }
        let path = fixture.0.to_string_lossy().into_owned();
        assert_eq!(
            local_list_dir(path.clone()).await.unwrap().len(),
            MAX_LOCAL_LIST_ENTRIES
        );
        std::fs::File::create(fixture.0.join("overflow")).unwrap();
        local_list_dir(path)
            .await
            .expect_err("over-limit entries must not be reported as a complete listing");
        let scanner = crate::ssh::upload::LocalSource::new(&fixture.0, true).unwrap();
        assert!(
            scanner.entries("selected").is_err(),
            "folder copy must fail before output on excessive entries"
        );
    }

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
    async fn local_save_staging_is_private_under_permissive_umask() {
        use std::os::unix::fs::PermissionsExt;

        const CHILD_PATH: &str = "REDTERM_PRIVATE_SAVE_TEST_PATH";
        if let Some(path) = std::env::var_os(CHILD_PATH) {
            let path = Path::new(&path);
            let mut file = create_local_save_file(path)
                .await
                .expect("create staged file");
            assert_eq!(
                file.metadata().await.unwrap().permissions().mode() & 0o777,
                0o600
            );
            file.write_all(b"private edited content").await.unwrap();
            file.flush().await.unwrap();
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let collision = create_local_save_file(path)
                .await
                .expect_err("must not reopen an existing file");
            assert_eq!(collision.kind(), std::io::ErrorKind::AlreadyExists);
            assert_eq!(std::fs::read(path).unwrap(), b"private edited content");
            return;
        }

        // umask is process-global: set it only in a fresh, single-test child.
        let root = std::env::temp_dir().join(format!(
            "redterm-private-save-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let result = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("umask 022; exec \"$@\"")
            .arg("redterm-private-save-test")
            .arg(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(format!(
                "{}::local_save_staging_is_private_under_permissive_umask",
                module_path!().split_once("::").unwrap().1
            ))
            .arg("--nocapture")
            .env(CHILD_PATH, root.join("staged"))
            .output();
        let staged_content = std::fs::read(root.join("staged"));
        std::fs::remove_dir_all(&root).unwrap();
        let output = result.expect("run isolated permissions test");
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(staged_content.unwrap(), b"private edited content");
    }

    #[tokio::test]
    async fn local_preview_revision_detects_same_size_rewrite() {
        use base64::Engine as _;

        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(
            ".redterm-preview-revision-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"first").expect("create test file");
        let path_text = path.to_string_lossy().to_string();
        let first = local_read_file(path_text.clone())
            .await
            .expect("initial preview");
        let unchanged = local_file_version(path_text.clone())
            .await
            .expect("stat unchanged file");

        std::fs::write(&path, b"later").expect("rewrite same-size file");
        std::fs::File::open(&path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000))
            .expect("set known modified time");
        let changed = local_file_version(path_text.clone())
            .await
            .expect("stat changed file");
        let refreshed = local_read_file(path_text).await.expect("changed preview");
        std::fs::remove_file(&path).expect("remove test file");

        assert_eq!(first.version, unchanged);
        assert_ne!(first.version, changed);
        assert_eq!(refreshed.version, changed);
        assert_eq!(refreshed.size, first.size);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(refreshed.content_base64)
                .unwrap(),
            b"later"
        );
    }

    #[tokio::test]
    async fn local_preview_revision_detects_atomic_replacement_with_preserved_mtime() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(".redterm-revision-{}", uuid::Uuid::new_v4()));
        let replacement = home.join(format!(".redterm-revision-{}", uuid::Uuid::new_v4()));
        let fixed_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::write(&path, b"first").expect("create original");
        std::fs::File::open(&path)
            .unwrap()
            .set_modified(fixed_time)
            .expect("set original mtime");
        let path_text = path.to_string_lossy().to_string();
        let original = local_read_file(path_text.clone())
            .await
            .expect("original preview");
        std::fs::write(&replacement, b"later").expect("stage replacement");
        std::fs::File::open(&replacement)
            .unwrap()
            .set_modified(fixed_time)
            .expect("preserve replacement mtime");
        std::fs::rename(&replacement, &path).expect("atomically replace original");
        let version = local_file_version(path_text.clone())
            .await
            .expect("replacement version");
        let replaced = local_read_file(path_text)
            .await
            .expect("replacement preview");
        let metadata = std::fs::metadata(&path).expect("replacement metadata");
        std::fs::remove_file(&path).expect("remove replacement");
        assert_eq!(metadata.len(), original.size);
        assert_eq!(metadata.modified().unwrap(), fixed_time);
        assert_ne!(original.version, version);
        assert_eq!(replaced.version, version);
        assert_eq!(replaced.content_base64, "bGF0ZXI=");
    }
    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn local_save_copy_rejects_unprotected_parent_and_delete_child_acl() {
        use std::os::unix::fs::PermissionsExt;
        let directory = local_home_dir_path().unwrap().join(format!(
            ".redterm-shared-save-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("source.md");
        std::fs::write(&source, b"original").unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o777)).unwrap();
        local_save_copy(
            source.to_string_lossy().into_owned(),
            "private".into(),
            "original".into(),
        )
        .await
        .expect_err("nonsticky shared parent must not permit another account to replace stage");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone allow delete_child,add_file"])
            .arg(&directory)
            .status()
            .unwrap()
            .success());
        local_save_copy(
            source.to_string_lossy().into_owned(),
            "private".into(),
            "original".into(),
        )
        .await
        .expect_err("macOS ACL can grant deletion despite 0700 mode");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert!(std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(&directory)
            .status()
            .unwrap()
            .success());
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o1777)).unwrap();
        let saved = local_save_copy(
            source.to_string_lossy().into_owned(),
            "private".into(),
            "original".into(),
        )
        .await
        .expect("owner-owned sticky directory protects stage names");
        assert_eq!(std::fs::read(&saved.path).unwrap(), b"private");
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        std::fs::remove_file(saved.path).unwrap();
        std::fs::remove_file(source).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn local_save_copy_preserves_original_xattr_and_mode() {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::PermissionsExt;

        let path = local_home_dir_path()
            .expect("test home directory")
            .join(format!(".redterm-metadata-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"original").expect("create original");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("set original mode");
        let name = c"user.redterm.metadata.test";
        let value = b"retain-this-attribute";
        let file = std::fs::File::open(&path).expect("open original");
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                    0,
                )
            },
            0,
            "set original xattr: {}",
            std::io::Error::last_os_error()
        );
        drop(file);

        let saved = local_save_copy(
            path.to_string_lossy().into_owned(),
            "replacement".into(),
            "original".into(),
        )
        .await
        .expect("save with metadata");
        let copy = Path::new(&saved.path);
        let file = std::fs::File::open(copy).expect("open saved copy");
        let mut restored = [0u8; 64];
        let size = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                restored.as_mut_ptr().cast(),
                restored.len(),
                0,
                0,
            )
        };
        let copy_mode = file.metadata().expect("copy metadata").permissions().mode() & 0o777;
        let original = std::fs::File::open(&path).expect("open unchanged source");
        let mut source_attr = [0u8; 64];
        let source_size = unsafe {
            libc::fgetxattr(
                original.as_raw_fd(),
                name.as_ptr(),
                source_attr.as_mut_ptr().cast(),
                source_attr.len(),
                0,
                0,
            )
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(std::fs::read(copy).unwrap(), b"replacement");
        assert_eq!(copy_mode, 0o640);
        assert_eq!(
            original.metadata().unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            size,
            value.len() as isize,
            "copy xattr: {}",
            std::io::Error::last_os_error()
        );
        assert_eq!(&restored[..size as usize], value);
        assert_eq!(source_size, value.len() as isize);
        assert_eq!(&source_attr[..source_size as usize], value);
        std::fs::remove_file(copy).expect("remove copy");
        std::fs::remove_file(&path).expect("remove source");
    }
    #[tokio::test]
    #[cfg(target_os = "macos")]
    async fn local_save_copy_preserves_acl_without_inheriting_parent_acl() {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
            fn acl_to_text(acl: *mut libc::c_void, length: *mut isize) -> *mut libc::c_char;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }
        fn acl_text(file: &std::fs::File) -> Option<Vec<u8>> {
            let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
            if acl.is_null() {
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::ENOENT)
                );
                return None;
            }
            let mut length = 0;
            let text = unsafe { acl_to_text(acl, &mut length) };
            assert!(
                !text.is_null(),
                "format ACL: {}",
                std::io::Error::last_os_error()
            );
            let value =
                unsafe { std::slice::from_raw_parts(text.cast::<u8>(), length as usize) }.to_vec();
            unsafe {
                acl_free(text.cast());
                acl_free(acl);
            }
            Some(value)
        }
        fn chmod(path: &Path, arg: &str, rule: Option<&str>) {
            let mut command = std::process::Command::new("/bin/chmod");
            command.arg(arg);
            if let Some(rule) = rule {
                command.arg(rule);
            }
            assert!(command.arg(path).status().expect("run chmod").success());
        }
        let directory = local_home_dir_path()
            .expect("test home directory")
            .join(format!(".redterm-acl-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).expect("create ACL parent");
        chmod(&directory, "+a", Some("everyone allow read,file_inherit"));
        let path = directory.join("document.md");
        std::fs::write(&path, b"original").expect("create source with inherited ACL");
        chmod(&path, "+a", Some("everyone deny execute"));
        let explicit_acl = acl_text(&std::fs::File::open(&path).unwrap()).expect("source ACL");
        let path_text = path.to_string_lossy().into_owned();
        let first = local_save_copy(path_text.clone(), "first".into(), "original".into())
            .await
            .expect("save with source ACL");
        assert_eq!(
            acl_text(&std::fs::File::open(&path).unwrap()),
            Some(explicit_acl.clone())
        );
        assert_eq!(
            acl_text(&std::fs::File::open(&first.path).unwrap()),
            Some(explicit_acl)
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"first");

        chmod(&path, "-N", None);
        assert!(acl_text(&std::fs::File::open(&path).unwrap()).is_none());
        let second = local_save_copy(path_text, "second".into(), "original".into())
            .await
            .expect("save without source ACL");
        assert!(
            acl_text(&std::fs::File::open(&second.path).unwrap()).is_none(),
            "must not inherit parent ACL"
        );
        assert_eq!(std::fs::read(&first.path).unwrap(), b"first");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        std::fs::remove_file(&first.path).expect("remove first revision");
        std::fs::remove_file(&second.path).expect("remove second revision");
        std::fs::remove_file(&path).expect("remove source");
        std::fs::remove_dir(&directory).expect("remove ACL parent");
    }

    #[tokio::test]
    async fn local_save_copy_rejects_stale_content_without_overwriting() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(
            ".redterm-save-conflict-test-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&path, b"original")
            .await
            .expect("create test file");
        let path_text = path.to_string_lossy().to_string();

        let conflict = local_save_copy(path_text.clone(), "mine".to_string(), "stale".to_string())
            .await
            .expect_err("stale save must fail");
        assert!(conflict.contains("File changed since it was opened"));
        assert_eq!(
            tokio::fs::read(&path).await.expect("read unchanged file"),
            b"original"
        );

        let saved = local_save_copy(
            path_text.clone(),
            "mine".to_string(),
            "original".to_string(),
        )
        .await
        .expect("save unchanged file");
        assert_ne!(saved.path, path_text);
        assert_eq!(
            saved.version,
            local_file_version(saved.path.clone())
                .await
                .expect("saved copy version")
        );
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"original");
        assert_eq!(tokio::fs::read(&saved.path).await.unwrap(), b"mine");
        // A failed save on a changed source must leave an already published
        // revision alone, not treat it as a temporary file to clean up.
        tokio::fs::write(&path, b"external edit").await.unwrap();
        local_save_copy(path_text, "later".into(), "original".into())
            .await
            .expect_err("external writer changed the source");
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"external edit");
        assert_eq!(tokio::fs::read(&saved.path).await.unwrap(), b"mine");
        tokio::fs::remove_file(&saved.path)
            .await
            .expect("remove revision");
        tokio::fs::remove_file(&path).await.expect("remove source");
    }
    #[tokio::test]
    async fn concurrent_local_copies_preserve_each_revision_and_source() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!("document-{}.md", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"original")
            .await
            .expect("create test file");
        let path_text = path.to_string_lossy().to_string();

        let first = local_save_copy(
            path_text.clone(),
            "first".to_string(),
            "original".to_string(),
        );
        let second = local_save_copy(
            path_text.clone(),
            "second".to_string(),
            "original".to_string(),
        );
        let (first, second) = tokio::join!(first, second);
        let first = first.expect("first revision");
        let second = second.expect("second revision");
        assert_ne!(first.path, second.path);
        assert_eq!(Path::new(&first.path).extension().unwrap(), "md");
        assert!(Path::new(&first.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("document-"));
        assert_eq!(Path::new(&first.path).parent(), path.parent());
        assert_eq!(
            first.version,
            local_file_version(first.path.clone()).await.unwrap()
        );
        assert_eq!(
            second.version,
            local_file_version(second.path.clone()).await.unwrap()
        );
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"original");
        assert_eq!(tokio::fs::read(&first.path).await.unwrap(), b"first");
        assert_eq!(tokio::fs::read(&second.path).await.unwrap(), b"second");
        tokio::fs::remove_file(&first.path)
            .await
            .expect("remove first revision");
        tokio::fs::remove_file(&second.path)
            .await
            .expect("remove second revision");
        tokio::fs::remove_file(&path).await.expect("remove source");
    }

    #[tokio::test]
    async fn repeated_local_saves_keep_origin_and_bounded_names_without_replacing_copies() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(
            "notes.redterm-not-a-uuid-{}.md",
            uuid::Uuid::new_v4()
        ));
        let origin_name = path.file_stem().unwrap().to_str().unwrap().to_owned();
        tokio::fs::write(&path, b"original")
            .await
            .expect("create source");
        let first = local_save_copy(
            path.to_string_lossy().into_owned(),
            "first".into(),
            "original".into(),
        )
        .await
        .expect("first copy");
        let second = local_save_copy(first.path.clone(), "second".into(), "first".into())
            .await
            .expect("second copy");
        let third = local_save_copy(second.path.clone(), "third".into(), "second".into())
            .await
            .expect("third copy");
        let first_name = Path::new(&first.path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let second_name = Path::new(&second.path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let third_name = Path::new(&third.path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let prefix = format!("{origin_name}.redterm-");
        for name in [first_name, second_name, third_name] {
            assert!(
                name.starts_with(&prefix),
                "origin must survive repeated saves: {name}"
            );
            assert!(name.ends_with(".md"));
            assert_eq!(name.len(), prefix.len() + 36 + ".md".len());
        }
        assert_ne!(first.path, second.path);
        assert_ne!(second.path, third.path);
        assert_eq!(first_name.len(), second_name.len());
        assert_eq!(second_name.len(), third_name.len());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"original");
        assert_eq!(tokio::fs::read(&first.path).await.unwrap(), b"first");
        assert_eq!(tokio::fs::read(&second.path).await.unwrap(), b"second");
        assert_eq!(tokio::fs::read(&third.path).await.unwrap(), b"third");
        for file in [&first.path, &second.path, &third.path] {
            tokio::fs::remove_file(file).await.expect("remove revision");
        }
        tokio::fs::remove_file(&path).await.expect("remove source");
    }
    #[test]
    fn local_entry_name_validation_rejects_separators_and_relative_names() {
        assert!(validate_local_entry_name("notes.txt").is_ok());
        assert!(validate_local_entry_name("my folder").is_ok());
        assert!(validate_local_entry_name("").is_err());
        assert!(validate_local_entry_name(".").is_err());
        assert!(validate_local_entry_name("..").is_err());
        assert!(validate_local_entry_name("a/b").is_err());
        assert!(validate_local_entry_name("a\\b").is_err());
        assert!(validate_local_entry_name("a\0b").is_err());
    }

    #[test]
    fn local_entry_scope_rejects_out_of_home_parents_and_bad_leafs() {
        let home = local_home_dir_path().expect("home directory should resolve");
        let expected_parent = std::fs::canonicalize(&home).unwrap_or_else(|_| home.clone());
        let inside = ensure_within_home_entry(&home.join("new-folder"));
        assert!(inside.is_ok());
        assert_eq!(
            inside.expect("scoped entry").parent(),
            Some(expected_parent.as_path())
        );
        assert!(ensure_within_home_entry(Path::new("/usr/local/bin/new-file")).is_err());
        assert!(ensure_within_home_entry(Path::new("../new-file")).is_err());
        assert!(ensure_within_home_entry(&home.join(".")).is_err());
        // A leaf separator is rejected before the path is ever split.
        assert!(validate_local_entry_name("a/b").is_err());
    }

    /// Collect progress events behind an Fn + Send + Sync closure like the
    /// real emitter.
    fn event_collector() -> (
        impl Fn(RemoveProgress) + Send + Sync,
        std::sync::Arc<std::sync::Mutex<Vec<RemoveProgress>>>,
    ) {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        (
            move |progress: RemoveProgress| {
                sink.lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(progress);
            },
            events,
        )
    }

    fn unique_test_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "redterm-remove-progress-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[tokio::test]
    async fn remove_dir_progress_reports_scan_then_every_entry() {
        let root = unique_test_root("tree");
        let nested = root.join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("file.txt"), "root file").unwrap();
        std::fs::write(nested.join("deep.txt"), "deep file").unwrap();
        let root_name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap();
        // root, a, b = 3 directories; 2 files = 5 deletable entries.
        let expected_total = 5usize;

        let (on_progress, events) = event_collector();
        remove_dir_all_with_progress(&root, &on_progress)
            .await
            .expect("delete tree");

        assert!(!root.exists(), "tree should be fully removed");
        let events = events.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(events
            .iter()
            .any(|event| event.phase == RemovePhase::Scanning && event.current == root_name));
        let deletes: Vec<&RemoveProgress> = events
            .iter()
            .filter(|event| event.phase == RemovePhase::Deleting)
            .collect();
        assert_eq!(deletes.len(), expected_total);
        // Files are unlinked before any directory is removed, and the root
        // directory itself is the final entry.
        assert_eq!(deletes[0].current, "file.txt");
        assert_eq!(deletes.last().expect("final event").current, root_name);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn remove_dir_progress_unlinks_windows_dir_links() {
        use std::os::windows::fs::symlink_dir;

        let root = unique_test_root("win-link");
        let outside = unique_test_root("win-link-outside");
        std::fs::create_dir_all(outside.join("target")).unwrap();
        std::fs::write(outside.join("target/kept.txt"), "must survive").unwrap();
        std::fs::create_dir_all(root.join("dir")).unwrap();
        // Creating a directory symlink needs developer mode or privilege;
        // skip the assertion path when the environment disallows it.
        if symlink_dir(&outside.join("target"), root.join("link")).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }
        // root, dir, and the link = 3 entries; the link must go through
        // remove_dir, not remove_file.
        let expected_total = 3usize;

        let (on_progress, events) = event_collector();
        remove_dir_all_with_progress(&root, &on_progress)
            .await
            .expect("delete tree with directory link");

        assert!(!root.exists());
        assert!(outside.join("target/kept.txt").exists(), "target untouched");
        let events = events.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let last = events.last().expect("completion event");
        assert_eq!(last.phase, RemovePhase::Deleting);
        assert_eq!(last.total, Some(expected_total));
        assert_eq!(last.deleted, expected_total);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remove_dir_progress_does_not_follow_symlinks() {
        let root = unique_test_root("symlink");
        let outside = unique_test_root("symlink-outside");
        std::fs::create_dir_all(outside.join("target")).unwrap();
        std::fs::write(outside.join("target/kept.txt"), "must survive").unwrap();
        std::fs::create_dir_all(root.join("dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("target"), root.join("link")).unwrap();
        // link is deleted as an entry; dir adds one directory. The linked
        // target's contents must not appear in the count.
        let expected_total = 3usize;

        let (on_progress, events) = event_collector();
        remove_dir_all_with_progress(&root, &on_progress)
            .await
            .expect("delete tree with symlink");

        assert!(!root.exists());
        assert!(outside.join("target/kept.txt").exists(), "target untouched");
        let events = events.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let last = events.last().expect("completion event");
        assert_eq!(last.phase, RemovePhase::Deleting);
        assert_eq!(last.total, Some(expected_total));
        assert_eq!(last.deleted, expected_total);
        let _ = std::fs::remove_dir_all(&outside);
    }
}

#[cfg(all(test, windows))]
mod windows_revision_tests {
    use super::*;
    use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
    use windows::Win32::Foundation::{FILETIME, HANDLE};
    use windows::Win32::Storage::FileSystem::SetFileTime;

    #[tokio::test]
    async fn local_preview_revision_detects_in_place_rewrite_with_restored_mtime() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(".redterm-revision-{}", uuid::Uuid::new_v4()));
        let fixed_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::write(&path, b"first").expect("create original");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(fixed_time)
            .expect("set original mtime");
        let path_text = path.to_string_lossy().to_string();
        let original = local_read_file(path_text.clone())
            .await
            .expect("initial preview");
        let original_metadata = std::fs::metadata(&path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"later").expect("rewrite same-size file in place");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(fixed_time)
            .expect("restore original mtime");
        let current_metadata = std::fs::metadata(&path).unwrap();
        let current = local_file_version(path_text.clone())
            .await
            .expect("refresh preview version");
        let refreshed = local_read_file(path_text).await.expect("updated preview");
        std::fs::remove_file(path).expect("remove test file");
        assert_eq!(original_metadata.len(), current_metadata.len());
        assert_eq!(
            original_metadata.modified().unwrap(),
            current_metadata.modified().unwrap()
        );
        assert_eq!(
            original_metadata.creation_time(),
            current_metadata.creation_time()
        );
        assert_ne!(
            original.version, current,
            "in-place rewrite must invalidate Refresh"
        );
        assert_eq!(refreshed.version, current);
        assert_eq!(refreshed.content_base64, "bGF0ZXI=");
    }

    #[tokio::test]
    async fn local_preview_revision_detects_replacement_with_identical_legacy_metadata() {
        let home = local_home_dir_path().expect("test home directory");
        let path = home.join(format!(".redterm-revision-{}", uuid::Uuid::new_v4()));
        let replacement = home.join(format!(".redterm-revision-{}", uuid::Uuid::new_v4()));
        let fixed_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::write(&path, b"first").expect("create original");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(fixed_time)
            .expect("set original mtime");
        let original_metadata = std::fs::metadata(&path).unwrap();
        let path_text = path.to_string_lossy().to_string();
        let original = local_read_file(path_text.clone())
            .await
            .expect("original preview");

        std::fs::write(&replacement, b"later").expect("stage replacement");
        let staged = std::fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap();
        staged
            .set_modified(fixed_time)
            .expect("set replacement mtime");
        let creation = original_metadata.creation_time();
        let creation = FILETIME {
            dwLowDateTime: creation as u32,
            dwHighDateTime: (creation >> 32) as u32,
        };
        unsafe { SetFileTime(HANDLE(staged.as_raw_handle()), Some(&creation), None, None) }
            .expect("preserve creation time");
        drop(staged);
        let staged_metadata = std::fs::metadata(&replacement).unwrap();
        assert_eq!(original_metadata.len(), staged_metadata.len());
        assert_eq!(
            original_metadata.modified().unwrap(),
            staged_metadata.modified().unwrap()
        );
        assert_eq!(
            original_metadata.creation_time(),
            staged_metadata.creation_time()
        );

        std::fs::rename(&replacement, &path).expect("atomically replace original");
        let replaced = local_file_version(path_text.clone())
            .await
            .expect("replacement revision");
        let preview = local_read_file(path_text.clone())
            .await
            .expect("replacement preview");
        assert_ne!(original.version, replaced);
        assert_eq!(preview.version, replaced);
        assert_eq!(preview.content_base64, "bGF0ZXI=");

        let saved = local_save_copy(path_text.clone(), "saved".into(), "later".into())
            .await
            .expect("save distinct revision");
        assert_ne!(saved.path, path_text);
        assert_ne!(saved.version, replaced);
        assert_eq!(
            saved.version,
            local_file_version(saved.path.clone())
                .await
                .expect("saved revision")
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"later");
        assert_eq!(std::fs::read(&saved.path).unwrap(), b"saved");
        std::fs::remove_file(&saved.path).expect("remove saved copy");
        std::fs::remove_file(path).expect("remove original");
    }
}

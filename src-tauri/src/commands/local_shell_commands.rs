use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, RwLock};

use super::ssh_commands::{
    claim_download_destination, ensure_local_sftp_preview_dir, make_download_progress_emitter,
    sanitize_file_name, SftpDownloadedFile, SftpFileContent, MAX_SFTP_PREVIEW_DOWNLOAD_BYTES,
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

fn configure_local_shell_command(command: &mut CommandBuilder) {
    command.env("TERM", LOCAL_SHELL_TERM);
    if let Some(home) = local_home_dir_path() {
        command.cwd(home);
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

async fn copy_with_progress(
    from: &Path,
    to: &Path,
    max_bytes: u64,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<u64, String> {
    let mut source = tokio::fs::File::open(from)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let mut destination = tokio::fs::File::create(to)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
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
        destination
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Failed to write file: {}", e))?;
        on_progress(total);
    }
    destination
        .flush()
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(total)
}

async fn local_download(
    app: &AppHandle,
    source: std::path::PathBuf,
    destination: std::path::PathBuf,
    remote_path_label: String,
    max_bytes: u64,
) -> Result<SftpDownloadedFile, String> {
    let total = tokio::fs::metadata(&source)
        .await
        .ok()
        .map(|metadata| metadata.len());
    let on_progress = make_download_progress_emitter(app.clone(), remote_path_label.clone(), total);
    let size = match copy_with_progress(&source, &destination, max_bytes, &on_progress).await {
        Ok(size) => size,
        Err(error) => {
            let _ = tokio::fs::remove_file(&destination).await;
            return Err(error);
        }
    };
    Ok(SftpDownloadedFile {
        remote_path: remote_path_label,
        local_path: destination.to_string_lossy().to_string(),
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

    let downloaded = local_download(
        &app,
        scoped.clone(),
        part_path.clone(),
        scoped_label,
        MAX_SFTP_PREVIEW_DOWNLOAD_BYTES,
    )
    .await?;
    if let Err(error) = tokio::fs::rename(&part_path, &destination).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!("Failed to finalize preview download: {}", error));
    }

    Ok(SftpDownloadedFile {
        local_path: destination.to_string_lossy().to_string(),
        ..downloaded
    })
}

/// Copy a local file into a user-chosen directory (defaults to Downloads).
#[tauri::command]
pub async fn local_download_to_dir(
    app: AppHandle,
    path: String,
    destination_dir: Option<String>,
) -> Result<SftpDownloadedFile, String> {
    let scoped = ensure_within_home(Path::new(&path))?;
    if !scoped.is_file() {
        return Err("File not found".to_string());
    }
    let downloads_dir = match destination_dir.as_deref().map(str::trim) {
        Some(dir) if !dir.is_empty() => std::path::PathBuf::from(dir),
        _ => app
            .path()
            .download_dir()
            .map_err(|e| format!("Failed to resolve Downloads directory: {}", e))?,
    };
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|e| format!("Failed to prepare download directory: {}", e))?;

    let file_name = scoped
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let destination = claim_download_destination(&downloads_dir, &sanitize_file_name(&file_name))?;
    let scoped_label = path.clone();

    local_download(&app, scoped, destination, scoped_label, u64::MAX).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

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
}

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;

use super::ssh_commands::{
    ensure_local_sftp_preview_dir, unique_download_path, SftpDownloadedFile, SftpFileContent,
};
use crate::ssh::SftpDirEntry;

const MAX_LOCAL_PREVIEW_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LOCAL_LIST_ENTRIES: usize = 10_000;

pub struct LocalShellManager {
    shells: RwLock<HashMap<String, LocalShell>>,
}

struct LocalShell {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
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
    if let Some(home) = local_home_dir_path() {
        command.cwd(home);
    }

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

    let session_id = uuid::Uuid::new_v4().to_string();
    manager.shells.write().await.insert(
        session_id.clone(),
        LocalShell {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
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
                    if emitter.emit(&data_event, &buffer[..read]).is_err() {
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

fn local_home_dir_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

#[tauri::command]
pub async fn local_shell_write(
    manager: State<'_, Arc<LocalShellManager>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let shells = manager.shells.read().await;
    let shell = shells
        .get(&session_id)
        .ok_or_else(|| "Local shell not found".to_string())?;
    let mut writer = shell
        .writer
        .lock()
        .map_err(|_| "Local shell writer is unavailable".to_string())?;
    writer
        .write_all(&data)
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Failed to write to local shell: {}", e))
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
    let mut master = shell
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
    let mut shells = manager.shells.write().await;
    if let Some(shell) = shells.remove(&session_id) {
        if let Ok(mut child) = shell.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        drop(shell.master);
    }
    Ok(())
}

fn sanitize_file_name(file_name: &str) -> String {
    let safe_name: String = file_name
        .chars()
        .filter(|c| {
            !c.is_control()
                && !std::path::is_separator(*c)
                && !matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
        .collect();
    if safe_name.is_empty() {
        "download".to_string()
    } else {
        safe_name
    }
}

fn unix_mtime(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Forward-slash normalized so the frontend breadcrumb model is
/// platform-agnostic (Windows accepts forward slashes in std::fs).
#[tauri::command]
pub async fn local_home_dir() -> Result<String, String> {
    let home = local_home_dir_path().ok_or("Home directory not found")?;
    let canonical = std::fs::canonicalize(&home)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| home.to_string_lossy().replace('\\', "/"));
    Ok(canonical)
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<SftpDirEntry>, String> {
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

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    if metadata.len() > MAX_LOCAL_PREVIEW_READ_BYTES {
        return Err(format!(
            "File is too large to preview ({} bytes exceeds the {} byte limit)",
            metadata.len(),
            MAX_LOCAL_PREVIEW_READ_BYTES
        ));
    }

    let mut file = tokio::fs::File::open(&path)
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
        destination
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Failed to write file: {}", e))?;
        total += read as u64;
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
) -> Result<SftpDownloadedFile, String> {
    let total = tokio::fs::metadata(&source)
        .await
        .ok()
        .map(|metadata| metadata.len());
    let on_progress = make_progress_emitter_local(app.clone(), remote_path_label.clone(), total);
    let size = match copy_with_progress(&source, &destination, &on_progress).await {
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

fn make_progress_emitter_local(
    app: AppHandle,
    path: String,
    total: Option<u64>,
) -> impl Fn(u64) + Send + Sync {
    move |transferred: u64| {
        let should_emit = transferred == 0
            || total.is_some_and(|size| transferred >= size)
            || transferred % (1 << 20) < 256 * 1024;
        if should_emit {
            let _ = app.emit(
                "sftp-download-progress",
                serde_json::json!({
                    "path": path,
                    "transferred": transferred,
                    "total": total,
                }),
            );
        }
    }
}

/// Copy a local file into the preview cache so it can be streamed through
/// the asset protocol (media playback).
#[tauri::command]
pub async fn local_download_file(
    app: AppHandle,
    path: String,
) -> Result<SftpDownloadedFile, String> {
    let source = std::path::PathBuf::from(&path);
    if !source.is_file() {
        return Err("File not found".to_string());
    }
    let preview_dir = ensure_local_sftp_preview_dir(&app)?;
    let part_path = preview_dir.join(format!(
        "{}-{}.part",
        uuid::Uuid::new_v4(),
        sanitize_file_name(
            source
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default()
                .as_str()
        )
    ));
    let destination = preview_dir.join(format!(
        "{}-{}",
        uuid::Uuid::new_v4(),
        sanitize_file_name(
            source
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default()
                .as_str()
        )
    ));

    let downloaded = local_download(&app, source, part_path.clone(), path).await?;
    if let Err(error) = tokio::fs::rename(&part_path, &destination).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!("Failed to finalize preview download: {}", error));
    }

    Ok(SftpDownloadedFile {
        local_path: destination.to_string_lossy().to_string(),
        ..downloaded
    })
}

/// Copy a local file into the user's Downloads directory.
#[tauri::command]
pub async fn local_download_to_downloads(
    app: AppHandle,
    path: String,
) -> Result<SftpDownloadedFile, String> {
    let source = std::path::PathBuf::from(&path);
    if !source.is_file() {
        return Err("File not found".to_string());
    }
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Failed to resolve Downloads directory: {}", e))?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|e| format!("Failed to prepare Downloads directory: {}", e))?;

    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let destination = unique_download_path(&downloads_dir, &sanitize_file_name(&file_name));

    local_download(&app, source, destination, path).await
}

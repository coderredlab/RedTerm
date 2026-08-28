use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

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
    if let Some(home) = local_home_dir() {
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

fn local_home_dir() -> Option<std::path::PathBuf> {
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

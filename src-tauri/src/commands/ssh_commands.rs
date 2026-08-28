use russh::client::{self, Config};
use russh::keys::PublicKeyOrCertificate;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, RwLock};
use uuid::Uuid;

use crate::ssh::known_hosts::{
    check_host_key_result, delete_known_host as delete_known_host_entry,
    list_known_hosts as list_known_hosts_entries, trust_host_key, HostKeyCheckResult,
    KnownHostEntry,
};
use crate::ssh::{AuthConfig, AuthMethod, SftpDirEntry, SshConnection, SshError, SshSession};
use crate::storage::{load_saved_password_for_connection, resolve_uploaded_key_for_auth};
#[cfg(not(target_os = "ios"))]
use tauri_plugin_redterm_android_paste::{
    read_clipboard_image as read_native_clipboard_image,
    set_keep_screen_on as set_native_keep_screen_on,
    set_keyboard_visible as set_native_keyboard_visible,
    ClipboardImageResult as NativeClipboardImageResult,
};
#[cfg(target_os = "android")]
use tauri_plugin_redterm_android_paste::{
    stop_foreground_service as stop_android_foreground_service,
    update_foreground_service as update_android_foreground_service,
};
#[cfg(target_os = "ios")]
use tauri_plugin_redterm_ios_native::{
    read_clipboard_image as read_native_clipboard_image,
    set_keep_screen_on as set_native_keep_screen_on,
    set_keyboard_visible as set_native_keyboard_visible,
    ClipboardImageResult as NativeClipboardImageResult,
};

pub struct SessionEntry {
    pub session: SshSession,
    pub connection: Arc<SshConnection>,
    recent_output: Arc<RwLock<RecentOutput>>,
    pub latest_snapshot: Arc<RwLock<Option<serde_json::Value>>>,
    pub next_seq: Arc<AtomicU64>,
}

pub struct SessionManager {
    sessions: RwLock<HashMap<String, SessionEntry>>,
}

pub struct RuntimeState {
    pub instance_id: String,
}

const HOST_KEY_CHALLENGE_LIFETIME: Duration = Duration::from_secs(120);
const MAX_PENDING_HOST_KEY_CHALLENGES: usize = 32;

struct PendingHostKeyChallenge {
    host: String,
    port: u16,
    public_key: String,
    fingerprint: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct HostKeyChallengeStore {
    pending: Mutex<HashMap<String, PendingHostKeyChallenge>>,
}

impl HostKeyChallengeStore {
    fn issue(
        &self,
        host: String,
        port: u16,
        public_key: String,
        fingerprint: String,
    ) -> Result<String, String> {
        let now = Instant::now();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Host key challenge store lock was poisoned".to_string())?;
        pending.retain(|_, challenge| challenge.expires_at > now);
        if pending.len() >= MAX_PENDING_HOST_KEY_CHALLENGES {
            return Err("Too many pending host key challenges".to_string());
        }
        let token = Uuid::new_v4().to_string();
        pending.insert(
            token.clone(),
            PendingHostKeyChallenge {
                host,
                port,
                public_key,
                fingerprint,
                expires_at: now + HOST_KEY_CHALLENGE_LIFETIME,
            },
        );
        Ok(token)
    }

    fn consume(&self, token: &str) -> Result<PendingHostKeyChallenge, String> {
        Uuid::parse_str(token).map_err(|_| "Invalid host key challenge".to_string())?;
        let challenge = self
            .pending
            .lock()
            .map_err(|_| "Host key challenge store lock was poisoned".to_string())?
            .remove(token)
            .ok_or_else(|| "Host key challenge is unavailable or already used".to_string())?;
        if challenge.expires_at <= Instant::now() {
            return Err("Host key challenge expired".to_string());
        }
        Ok(challenge)
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "status")]
pub enum HostKeyPreflightResponse {
    #[serde(rename = "trusted")]
    Trusted,
    #[serde(rename = "unknown")]
    Unknown {
        algorithm: String,
        fingerprint: String,
        public_key: String,
        challenge_token: String,
    },
    #[serde(rename = "changed")]
    Changed {
        algorithm: String,
        fingerprint: String,
        public_key: String,
        known_fingerprints: Vec<String>,
        challenge_token: String,
    },
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn add_session(&self, id: String, entry: SessionEntry) {
        self.sessions.write().await.insert(id, entry);
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub async fn session_count(&self) -> usize {
        self.sessions.read().await.len()
    }

    pub async fn remove_session(&self, id: &str) -> Option<SessionEntry> {
        self.sessions.write().await.remove(id)
    }
}

#[derive(Clone, serde::Serialize)]
pub struct SshDataEvent {
    pub session_id: String,
    pub seq: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, serde::Serialize)]
pub struct SshSessionExitEvent {
    pub session_id: String,
}

#[derive(Clone, serde::Serialize)]
pub struct SshImageUploadResult {
    pub remote_path: String,
    pub remote_os: String,
}

#[derive(Clone, serde::Serialize)]
pub struct SshDataChunk {
    pub seq: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, serde::Serialize)]
pub struct StoredSessionSnapshot {
    pub snapshot: serde_json::Value,
    pub last_seq: u64,
}

struct HostKeyPreflightHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    result: Arc<Mutex<Option<HostKeyCheckResult>>>,
}

impl client::Handler for HostKeyPreflightHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let server_public_key = server_key.public_key();
        let result = check_host_key_result(
            &self.host,
            self.port,
            &server_public_key,
            &self.known_hosts_path,
        )
        .map_err(|e| SshError::ConnectionFailed(format!("Host key check failed: {}", e)))?;
        let trusted = matches!(result, HostKeyCheckResult::Trusted);
        *self.result.lock().map_err(|_| {
            SshError::ConnectionFailed("Host key preflight state was poisoned".to_string())
        })? = Some(result);
        Ok(trusted)
    }
}

fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("known_hosts"))
}

const SSH_DATA_CHANNEL_CAPACITY: usize = 64;
const MAX_SSH_EVENT_BYTES: usize = 64 * 1024;
const MAX_CLIPBOARD_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_RECENT_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECENT_CHUNK_COUNT: usize = 4096;
const SSH_EVENT_BATCH_WINDOW: Duration = Duration::from_millis(4);
const HOST_KEY_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_SHELL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct RecentOutput {
    chunks: VecDeque<SshDataChunk>,
    total_bytes: usize,
}

impl RecentOutput {
    fn push(&mut self, chunk: SshDataChunk) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.data.len());
        self.chunks.push_back(chunk);
        while self.chunks.len() > MAX_RECENT_CHUNK_COUNT
            || self.total_bytes > MAX_RECENT_CHUNK_BYTES
        {
            if let Some(removed) = self.chunks.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
        }
    }

    fn discard_through(&mut self, last_seq: u64) {
        while self
            .chunks
            .front()
            .is_some_and(|chunk| chunk.seq <= last_seq)
        {
            if let Some(removed) = self.chunks.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
        }
    }
}

fn detect_image_extension(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("png");
    }
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

async fn upload_clipboard_image_bytes(
    connection: &SshConnection,
    data: &[u8],
) -> Result<SshImageUploadResult, String> {
    let extension = detect_image_extension(data)
        .ok_or_else(|| "Clipboard content is not a supported image".to_string())?;
    let remote_os = connection
        .detect_remote_os()
        .await
        .map_err(|e| e.to_string())?;

    if remote_os != "linux" && remote_os != "macos" {
        return Err(format!(
            "Image paste upload is supported only on Linux/macOS servers (detected: {})",
            remote_os
        ));
    }

    let remote_path = connection
        .upload_file_via_sftp(extension, data)
        .await
        .map_err(|e| e.to_string())?;

    Ok(SshImageUploadResult {
        remote_path,
        remote_os,
    })
}

fn ensure_local_clipboard_image_path(app: &AppHandle, local_path: &str) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {}", e))?
        .join("clipboard-paste");

    let canonical_base = std::fs::canonicalize(&base_dir)
        .or_else(|_| {
            std::fs::create_dir_all(&base_dir)?;
            std::fs::canonicalize(&base_dir)
        })
        .map_err(|e| format!("Failed to prepare clipboard cache dir: {}", e))?;

    let canonical_candidate = std::fs::canonicalize(Path::new(local_path))
        .map_err(|e| format!("Failed to access pasted image file: {}", e))?;

    if !canonical_candidate.starts_with(&canonical_base) {
        return Err("Local pasted image path is outside the allowed cache directory".to_string());
    }

    Ok(canonical_candidate)
}

#[cfg(target_os = "ios")]
fn clipboard_image_staging_directory(app: &AppHandle) -> Result<String, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to resolve app cache dir: {error}"))?
        .join("clipboard-paste");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to prepare clipboard cache dir: {error}"))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn ssh_check_host_key(
    app: AppHandle,
    challenge_store: State<'_, Arc<HostKeyChallengeStore>>,
    host: String,
    port: u16,
) -> Result<HostKeyPreflightResponse, String> {
    let known_hosts_path = known_hosts_path(&app)?;
    let result = Arc::new(Mutex::new(None));
    let config = Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        inactivity_timeout: Some(HOST_KEY_PREFLIGHT_TIMEOUT),
        ..Config::default()
    };
    let handler = HostKeyPreflightHandler {
        host: host.clone(),
        port,
        known_hosts_path,
        result: Arc::clone(&result),
    };

    let connect_result = tokio::time::timeout(
        HOST_KEY_PREFLIGHT_TIMEOUT,
        client::connect(Arc::new(config), (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| "SSH host key preflight timed out".to_string())?;
    match connect_result {
        Ok(handle) => {
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                handle.disconnect(
                    russh::Disconnect::ByApplication,
                    "host key preflight complete",
                    "",
                ),
            )
            .await;
        }
        Err(error) => {
            if result
                .lock()
                .map_err(|_| "Host key preflight state was poisoned".to_string())?
                .is_none()
            {
                return Err(error.to_string());
            }
        }
    }

    let preflight_result = result
        .lock()
        .map_err(|_| "Host key preflight state was poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Host key preflight did not receive a server key".to_string())?;
    match preflight_result {
        HostKeyCheckResult::Trusted => Ok(HostKeyPreflightResponse::Trusted),
        HostKeyCheckResult::Unknown {
            algorithm,
            fingerprint,
            public_key,
        } => {
            let challenge_token =
                challenge_store.issue(host, port, public_key.clone(), fingerprint.clone())?;
            Ok(HostKeyPreflightResponse::Unknown {
                algorithm,
                fingerprint,
                public_key,
                challenge_token,
            })
        }
        HostKeyCheckResult::Changed {
            algorithm,
            fingerprint,
            public_key,
            known_fingerprints,
        } => {
            let challenge_token =
                challenge_store.issue(host, port, public_key.clone(), fingerprint.clone())?;
            Ok(HostKeyPreflightResponse::Changed {
                algorithm,
                fingerprint,
                public_key,
                known_fingerprints,
                challenge_token,
            })
        }
    }
}

#[tauri::command]
pub fn ssh_trust_host_key(
    app: AppHandle,
    challenge_store: State<'_, Arc<HostKeyChallengeStore>>,
    challenge_token: String,
) -> Result<(), String> {
    let challenge = challenge_store.consume(&challenge_token)?;
    let path = known_hosts_path(&app)?;
    trust_host_key(
        &challenge.host,
        challenge.port,
        &challenge.public_key,
        &challenge.fingerprint,
        path,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_known_hosts(app: AppHandle) -> Result<Vec<KnownHostEntry>, String> {
    let path = known_hosts_path(&app)?;
    list_known_hosts_entries(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_known_host(app: AppHandle, host: String, port: u16) -> Result<(), String> {
    let path = known_hosts_path(&app)?;
    delete_known_host_entry(&host, port, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    session_manager: State<'_, Arc<SessionManager>>,
    host: String,
    port: u16,
    auth: AuthConfig,
    cols: u32,
    rows: u32,
) -> Result<String, String> {
    let AuthConfig { username, method } = auth;
    let method = match method {
        AuthMethod::StoredPassword { connection_id } => AuthMethod::Password {
            password: load_saved_password_for_connection(
                &app,
                &connection_id,
                &host,
                port,
                &username,
            )?,
        },
        AuthMethod::Key { key_id, passphrase } => AuthMethod::ResolvedKey {
            key_path: resolve_uploaded_key_for_auth(&app, &key_id, &host, port, &username)?,
            passphrase,
        },
        AuthMethod::ResolvedKey { .. } => {
            return Err("Resolved SSH key paths cannot be supplied by the renderer".to_string());
        }
        method => method,
    };
    let auth = AuthConfig { username, method };
    let session_id = Uuid::new_v4().to_string();

    let (data_tx, mut data_rx) = mpsc::channel::<Vec<u8>>(SSH_DATA_CHANNEL_CAPACITY);
    let (exit_tx, exit_rx) = oneshot::channel::<()>();
    let recent_output = Arc::new(RwLock::new(RecentOutput::default()));
    let next_seq = Arc::new(AtomicU64::new(0));
    let latest_snapshot = Arc::new(RwLock::new(None));

    let app_clone = app.clone();
    let session_id_for_task = session_id.clone();
    let recent_output_for_task = Arc::clone(&recent_output);
    let next_seq_for_task = Arc::clone(&next_seq);
    tokio::spawn(async move {
        let mut pending = None;
        loop {
            let mut batch = match pending.take() {
                Some(data) => data,
                None => match data_rx.recv().await {
                    Some(data) => data,
                    None => break,
                },
            };
            let deadline = tokio::time::Instant::now() + SSH_EVENT_BATCH_WINDOW;
            let mut channel_closed = false;

            while batch.len() < MAX_SSH_EVENT_BYTES {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => break,
                    next = data_rx.recv() => {
                        match next {
                            Some(more) if batch.len() + more.len() <= MAX_SSH_EVENT_BYTES => {
                                batch.extend(more);
                            }
                            Some(more) => {
                                pending = Some(more);
                                break;
                            }
                            None => {
                                channel_closed = true;
                                break;
                            }
                        }
                    }
                }
            }

            let seq = next_seq_for_task.fetch_add(1, Ordering::Relaxed) + 1;
            {
                let mut output = recent_output_for_task.write().await;
                output.push(SshDataChunk {
                    seq,
                    data: batch.clone(),
                });
            }
            let _ = app_clone.emit(
                &format!("ssh-data-{}", session_id_for_task),
                SshDataEvent {
                    session_id: session_id_for_task.clone(),
                    seq,
                    data: batch,
                },
            );
            if channel_closed {
                break;
            }
        }
    });

    let known_hosts_path = known_hosts_path(&app)?;

    // Connect
    let mut connection = tokio::time::timeout(
        SSH_CONNECT_TIMEOUT,
        SshConnection::connect(&host, port, auth, known_hosts_path),
    )
    .await
    .map_err(|_| "SSH connection timed out".to_string())?
    .map_err(|e| e.to_string())?;

    // Open session with PTY
    let session = tokio::time::timeout(
        SSH_SHELL_TIMEOUT,
        connection.open_shell(cols, rows, data_tx, Some(exit_tx)),
    )
    .await
    .map_err(|_| "SSH shell setup timed out".to_string())?
    .map_err(|e| e.to_string())?;

    session_manager
        .add_session(
            session_id.clone(),
            SessionEntry {
                session,
                connection: Arc::new(connection),
                recent_output,
                latest_snapshot,
                next_seq,
            },
        )
        .await;

    // Start/update foreground service
    #[cfg(target_os = "android")]
    {
        let session_count = session_manager.session_count().await;
        if let Err(error) = update_android_foreground_service(&app, session_count) {
            log::error!(
                "failed to update android foreground service after connect: {}",
                error
            );
        }
    }

    let app_clone = app.clone();
    let session_id_for_exit_task = session_id.clone();
    let session_manager_for_exit_task = session_manager.inner().clone();
    tokio::spawn(async move {
        if exit_rx.await.is_err() {
            return;
        }

        let removed_entry = session_manager_for_exit_task
            .remove_session(&session_id_for_exit_task)
            .await;

        if let Some(entry) = removed_entry {
            let _ = entry.session.close().await;

            // Update/stop foreground service
            #[cfg(target_os = "android")]
            {
                let session_count = session_manager_for_exit_task.session_count().await;
                let foreground_result = if session_count > 0 {
                    update_android_foreground_service(&app_clone, session_count)
                } else {
                    stop_android_foreground_service(&app_clone)
                };
                if let Err(error) = foreground_result {
                    log::error!(
                        "failed to update android foreground service after exit: {}",
                        error
                    );
                }
            }

            let _ = app_clone.emit(
                &format!("ssh-exit-{}", session_id_for_exit_task),
                SshSessionExitEvent {
                    session_id: session_id_for_exit_task,
                },
            );
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_session_exists(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<bool, String> {
    Ok(session_manager
        .sessions
        .read()
        .await
        .contains_key(&session_id))
}

#[tauri::command]
pub async fn ssh_store_session_snapshot(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    snapshot: serde_json::Value,
    last_seq: u64,
) -> Result<(), String> {
    let (recent_output, latest_snapshot) = {
        let sessions = session_manager.sessions.read().await;
        sessions
            .get(&session_id)
            .map(|entry| {
                (
                    Arc::clone(&entry.recent_output),
                    Arc::clone(&entry.latest_snapshot),
                )
            })
            .ok_or_else(|| "Session not found".to_string())?
    };

    *latest_snapshot.write().await = Some(
        serde_json::to_value(StoredSessionSnapshot { snapshot, last_seq })
            .map_err(|e| e.to_string())?,
    );

    recent_output.write().await.discard_through(last_seq);
    Ok(())
}

#[tauri::command]
pub async fn ssh_get_session_snapshot(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let (latest_snapshot, recent_output, next_seq) = {
        let sessions = session_manager.sessions.read().await;
        sessions
            .get(&session_id)
            .map(|entry| {
                (
                    Arc::clone(&entry.latest_snapshot),
                    Arc::clone(&entry.recent_output),
                    Arc::clone(&entry.next_seq),
                )
            })
            .ok_or_else(|| "Session not found".to_string())?
    };

    let stored = latest_snapshot.read().await.clone();
    let Some(snapshot) = stored else {
        return Ok(None);
    };

    let snapshot_last_seq = snapshot
        .get("last_seq")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let first_retained_seq = recent_output
        .read()
        .await
        .chunks
        .front()
        .map(|chunk| chunk.seq);
    let last_emitted_seq = next_seq.load(Ordering::Relaxed);
    if first_retained_seq.unwrap_or(last_emitted_seq + 1) > snapshot_last_seq + 1 {
        *latest_snapshot.write().await = None;
        return Ok(None);
    }

    Ok(Some(snapshot))
}

#[tauri::command]
pub async fn ssh_get_session_output(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<Vec<SshDataChunk>, String> {
    let recent_output = {
        let sessions = session_manager.sessions.read().await;
        sessions
            .get(&session_id)
            .map(|entry| Arc::clone(&entry.recent_output))
            .ok_or_else(|| "Session not found".to_string())?
    };

    let chunks = recent_output.read().await.chunks.iter().cloned().collect();
    Ok(chunks)
}

#[tauri::command]
pub async fn get_runtime_instance_id(
    runtime_state: State<'_, Arc<RuntimeState>>,
) -> Result<String, String> {
    Ok(runtime_state.instance_id.clone())
}

#[tauri::command]
pub async fn ssh_write(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = {
        let sessions = session_manager.sessions.read().await;
        sessions
            .get(&session_id)
            .map(|entry| entry.session.command_handle())
            .ok_or_else(|| "Session not found".to_string())?
    };

    session.write(&data).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let session = {
        let sessions = session_manager.sessions.read().await;
        sessions
            .get(&session_id)
            .map(|entry| entry.session.command_handle())
            .ok_or_else(|| "Session not found".to_string())?
    };

    session
        .resize(cols, rows)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    let entry = session_manager
        .remove_session(&session_id)
        .await
        .ok_or_else(|| "Session not found".to_string())?;

    entry.session.close().await.map_err(|e| e.to_string())?;

    // Update/stop foreground service
    #[cfg(target_os = "android")]
    {
        let session_count = session_manager.session_count().await;
        let foreground_result = if session_count > 0 {
            update_android_foreground_service(&app, session_count)
        } else {
            stop_android_foreground_service(&app)
        };
        if let Err(error) = foreground_result {
            log::error!(
                "failed to update android foreground service after disconnect: {}",
                error
            );
        }
    }
    let _ = &app; // suppress unused warning on non-android

    Ok(())
}

#[tauri::command]
pub async fn ssh_upload_clipboard_image(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<SshImageUploadResult, String> {
    if data.is_empty() {
        return Err("No image data provided".to_string());
    }
    if data.len() as u64 > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("Clipboard image exceeds 10 MiB".to_string());
    }
    let sessions = session_manager.sessions.read().await;
    let connection = sessions
        .get(&session_id)
        .map(|entry| Arc::clone(&entry.connection))
        .ok_or_else(|| "Session not found".to_string())?;

    drop(sessions);
    upload_clipboard_image_bytes(&connection, &data).await
}

#[tauri::command]
pub async fn ssh_upload_clipboard_image_from_local_path(
    app: AppHandle,
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    local_path: String,
) -> Result<SshImageUploadResult, String> {
    let safe_local_path = ensure_local_clipboard_image_path(&app, &local_path)?;
    let metadata = std::fs::metadata(&safe_local_path)
        .map_err(|e| format!("Failed to inspect pasted image file: {}", e))?;
    if metadata.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("Clipboard image exceeds 10 MiB".to_string());
    }

    let data = std::fs::read(&safe_local_path)
        .map_err(|e| format!("Failed to read pasted image file: {}", e))?;
    std::fs::remove_file(&safe_local_path)
        .map_err(|e| format!("Failed to remove pasted image cache file: {}", e))?;

    if data.is_empty() {
        return Err("No image data provided".to_string());
    }

    let sessions = session_manager.sessions.read().await;
    let connection = sessions
        .get(&session_id)
        .map(|entry| Arc::clone(&entry.connection))
        .ok_or_else(|| "Session not found".to_string())?;

    drop(sessions);
    upload_clipboard_image_bytes(&connection, &data).await
}

#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> Result<NativeClipboardImageResult, String> {
    #[cfg(target_os = "ios")]
    {
        return read_native_clipboard_image(&app, clipboard_image_staging_directory(&app)?);
    }

    #[cfg(not(target_os = "ios"))]
    read_native_clipboard_image(&app)
}

#[tauri::command]
pub async fn set_keep_screen_on(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_native_keep_screen_on(&app, enabled)
}

#[tauri::command]
pub async fn set_keyboard_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    set_native_keyboard_visible(&app, visible)
}

const MAX_SFTP_PREVIEW_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SFTP_PREVIEW_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, serde::Serialize)]
pub struct SftpFileContent {
    pub path: String,
    pub content_base64: String,
    pub size: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct SftpDownloadedFile {
    pub remote_path: String,
    pub local_path: String,
    pub size: u64,
}

async fn sftp_connection_for_session(
    session_manager: &State<'_, Arc<SessionManager>>,
    session_id: &str,
) -> Result<Arc<SshConnection>, String> {
    let sessions = session_manager.sessions.read().await;
    sessions
        .get(session_id)
        .map(|entry| Arc::clone(&entry.connection))
        .ok_or_else(|| "Session not found".to_string())
}

fn ensure_local_sftp_preview_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {}", e))?
        .join("sftp-preview");

    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to prepare preview cache dir: {}", e))?;
    prune_stale_sftp_previews(&base_dir);
    Ok(base_dir)
}

const SFTP_PREVIEW_PART_MAX_AGE_SECS: u64 = 60 * 60;
const SFTP_PREVIEW_MAX_AGE_SECS: u64 = 24 * 60 * 60;

fn prune_stale_sftp_previews(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let age: Option<u64> = match metadata.modified() {
            Ok(modified) => now.duration_since(modified).ok().map(|d| d.as_secs()),
            Err(_) => continue,
        };
        let stale_part = entry.file_name().to_string_lossy().ends_with(".part")
            && age
                .map(|secs| secs > SFTP_PREVIEW_PART_MAX_AGE_SECS)
                .unwrap_or(true);
        let stale = age
            .map(|secs| secs > SFTP_PREVIEW_MAX_AGE_SECS)
            .unwrap_or(false);
        if stale_part || stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub async fn sftp_list_dir(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpDirEntry>, String> {
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;
    connection
        .list_dir_via_sftp(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_read_file(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> Result<SftpFileContent, String> {
    use base64::Engine as _;

    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;
    let data = connection
        .read_file_via_sftp(&path, MAX_SFTP_PREVIEW_READ_BYTES)
        .await
        .map_err(|e| e.to_string())?;
    let size = data.len() as u64;
    Ok(SftpFileContent {
        path,
        content_base64: base64::engine::general_purpose::STANDARD.encode(&data),
        size,
    })
}

#[tauri::command]
pub async fn sftp_download_file(
    app: AppHandle,
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    remote_path: String,
) -> Result<SftpDownloadedFile, String> {
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;

    let file_name = remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let safe_name: String = file_name
        .chars()
        .filter(|c| !c.is_control() && !std::path::is_separator(*c))
        .collect();
    let safe_name = if safe_name.is_empty() {
        "download".to_string()
    } else {
        safe_name
    };

    let preview_dir = ensure_local_sftp_preview_dir(&app)?;
    let part_path = preview_dir.join(format!("{}-{}.part", Uuid::new_v4(), safe_name));
    let destination = preview_dir.join(format!("{}-{}", Uuid::new_v4(), safe_name));
    if !destination.starts_with(&preview_dir) || !part_path.starts_with(&preview_dir) {
        return Err("Invalid preview destination path".to_string());
    }

    let size = match connection
        .download_file_via_sftp(&remote_path, &part_path, MAX_SFTP_PREVIEW_DOWNLOAD_BYTES)
        .await
    {
        Ok(size) => size,
        Err(error) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(error.to_string());
        }
    };

    if let Err(error) = tokio::fs::rename(&part_path, &destination).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!("Failed to finalize preview download: {}", error));
    }

    Ok(SftpDownloadedFile {
        remote_path,
        local_path: destination.to_string_lossy().to_string(),
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_ssh_output_is_pruned_by_count_and_bytes() {
        let mut output = RecentOutput::default();
        for seq in 1..=5000 {
            output.push(SshDataChunk {
                seq,
                data: vec![0; 1024],
            });
        }

        assert!(output.chunks.len() <= MAX_RECENT_CHUNK_COUNT);
        assert!(output.total_bytes <= MAX_RECENT_CHUNK_BYTES);
        assert_eq!(output.chunks.back().map(|chunk| chunk.seq), Some(5000));
    }

    #[test]
    fn host_key_challenges_are_bound_and_single_use() {
        let store = HostKeyChallengeStore::default();
        let token = store
            .issue(
                "example.com".to_string(),
                22,
                "ssh-ed25519 AAAAtest".to_string(),
                "SHA256:test".to_string(),
            )
            .expect("challenge should be issued");

        let challenge = store
            .consume(&token)
            .expect("challenge should be consumable once");
        assert_eq!(challenge.host, "example.com");
        assert_eq!(challenge.port, 22);
        assert_eq!(challenge.public_key, "ssh-ed25519 AAAAtest");
        assert_eq!(challenge.fingerprint, "SHA256:test");
        assert!(store.consume(&token).is_err());
    }

    #[test]
    fn clipboard_image_extension_comes_only_from_validated_bytes() {
        assert_eq!(
            detect_image_extension(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("png")
        );
        assert_eq!(detect_image_extension(&[0xff, 0xd8, 0xff]), Some("jpg"));
        assert_eq!(detect_image_extension(b"GIF89a"), Some("gif"));
        assert_eq!(detect_image_extension(b"RIFF0000WEBP"), Some("webp"));
        assert_eq!(detect_image_extension(b"not-an-image"), None);
    }
}

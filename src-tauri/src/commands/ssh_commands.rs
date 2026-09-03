use russh::client::{self, Config};
use russh::keys::PublicKeyOrCertificate;
use std::collections::{HashMap, VecDeque};
#[cfg(windows)]
use std::os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, LazyLock, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, RwLock};
use uuid::Uuid;
#[cfg(windows)]
use windows::Win32::{
    Foundation::{GENERIC_WRITE, HANDLE},
    Storage::FileSystem::{
        FileDispositionInfo, GetFinalPathNameByHandleW, SetFileInformationByHandle, DELETE,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_NAME_NORMALIZED, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, GETFINALPATHNAMEBYHANDLE_FLAGS, VOLUME_NAME_DOS,
    },
};

use crate::ssh::known_hosts::{
    check_host_key_result, delete_known_host as delete_known_host_entry,
    list_known_hosts as list_known_hosts_entries, trust_host_key, HostKeyCheckResult,
    KnownHostEntry,
};
use crate::ssh::{AuthConfig, AuthMethod, SftpDirEntry, SshConnection, SshError, SshSession};
use crate::storage::{load_saved_password_for_connection, resolve_uploaded_key_for_auth};
#[cfg(target_os = "android")]
use tauri_plugin_redterm_android_paste::read_clipboard_image as read_native_clipboard_image;
#[cfg(not(target_os = "ios"))]
use tauri_plugin_redterm_android_paste::{
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Default)]
pub struct DesktopClipboardState {
    clipboard: Mutex<Option<arboard::Clipboard>>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl DesktopClipboardState {
    fn with_clipboard<T>(
        &self,
        operation: impl FnOnce(&mut arboard::Clipboard) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .clipboard
            .lock()
            .map_err(|_| "Clipboard state lock was poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(
                arboard::Clipboard::new()
                    .map_err(|error| format!("Failed to open clipboard: {error}"))?,
            );
        }
        operation(guard.as_mut().expect("clipboard initialized above"))
    }
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
const MAX_CLIPBOARD_IMAGE_PIXELS: usize = 32 * 1024 * 1024;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const MAX_CLIPBOARD_CACHE_BYTES: u64 = 50 * 1024 * 1024;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const MAX_CLIPBOARD_CACHE_FILES: usize = 20;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const MAX_CLIPBOARD_CACHE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
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

fn prepare_clipboard_image_staging_directory(directory: &Path) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to prepare clipboard cache dir: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to secure clipboard cache dir: {error}"))?;
    }
    Ok(())
}

fn clipboard_image_staging_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to resolve app cache dir: {error}"))?
        .join("clipboard-paste");
    prepare_clipboard_image_staging_directory(&directory)?;
    Ok(directory)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct ClipboardCacheEntry {
    path: PathBuf,
    modified: std::time::SystemTime,
    len: u64,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn prune_clipboard_image_cache_with_limits(
    directory: &Path,
    protected_path: Option<&Path>,
    now: std::time::SystemTime,
    max_age: Duration,
    max_files: usize,
    max_bytes: u64,
) -> Result<(), String> {
    let entries = std::fs::read_dir(directory)
        .map_err(|error| format!("Failed to inspect clipboard cache dir: {error}"))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to inspect clipboard cache: {error}"))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Failed to inspect clipboard cache file: {error}"))?;
        if metadata.is_file() {
            files.push(ClipboardCacheEntry {
                path: entry.path(),
                modified: metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                len: metadata.len(),
            });
        }
    }
    files.sort_by(|left, right| {
        let left_protected = protected_path.is_some_and(|path| path == left.path);
        let right_protected = protected_path.is_some_and(|path| path == right.path);
        right_protected
            .cmp(&left_protected)
            .then_with(|| right.modified.cmp(&left.modified))
    });

    let mut retained_files = 0_usize;
    let mut retained_bytes = 0_u64;
    for file in files {
        let protected = protected_path.is_some_and(|path| path == file.path);
        let expired = now
            .duration_since(file.modified)
            .is_ok_and(|age| age > max_age);
        let over_budget =
            retained_files >= max_files || retained_bytes.saturating_add(file.len) > max_bytes;
        if !protected && (expired || over_budget) {
            match std::fs::remove_file(&file.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Failed to prune clipboard cache file: {error}"));
                }
            }
        } else {
            retained_files += 1;
            retained_bytes = retained_bytes.saturating_add(file.len);
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn prune_clipboard_image_cache(
    directory: &Path,
    protected_path: Option<&Path>,
) -> Result<(), String> {
    prune_clipboard_image_cache_with_limits(
        directory,
        protected_path,
        std::time::SystemTime::now(),
        MAX_CLIPBOARD_CACHE_AGE,
        MAX_CLIPBOARD_CACHE_FILES,
        MAX_CLIPBOARD_CACHE_BYTES,
    )
}

#[cfg(all(not(any(target_os = "android", target_os = "ios")), unix))]
fn write_private_clipboard_image(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Failed to create staged clipboard image: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Failed to stage clipboard image: {error}"))
}

#[cfg(all(not(any(target_os = "android", target_os = "ios")), not(unix)))]
fn write_private_clipboard_image(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|error| format!("Failed to stage clipboard image: {error}"))
}

struct ClipboardPngWriter {
    bytes: Vec<u8>,
    limit: usize,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl std::io::Write for ClipboardPngWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        if buffer.len() > remaining {
            return Err(std::io::Error::other("Clipboard image exceeds 10 MiB"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn encode_clipboard_rgba_as_png(
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;

    let pixel_count = width
        .checked_mul(height)
        .ok_or_else(|| "Clipboard image dimensions are too large".to_string())?;
    if width == 0 || height == 0 {
        return Err("Clipboard image has invalid RGBA data".to_string());
    }
    if pixel_count > MAX_CLIPBOARD_IMAGE_PIXELS {
        return Err("Clipboard image dimensions exceed the 32-megapixel limit".to_string());
    }
    let expected_len = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "Clipboard image dimensions are too large".to_string())?;
    if rgba.len() != expected_len {
        return Err("Clipboard image has invalid RGBA data".to_string());
    }
    let width =
        u32::try_from(width).map_err(|_| "Clipboard image width is too large".to_string())?;
    let height =
        u32::try_from(height).map_err(|_| "Clipboard image height is too large".to_string())?;
    let mut png = ClipboardPngWriter {
        bytes: Vec::new(),
        limit: MAX_CLIPBOARD_IMAGE_BYTES as usize,
    };
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(rgba, width, height, image::ColorType::Rgba8.into())
        .map_err(|error| format!("Failed to encode clipboard image: {error}"))?;
    Ok(png.bytes)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn read_desktop_clipboard_image(
    app: &AppHandle,
    clipboard_state: &DesktopClipboardState,
) -> Result<NativeClipboardImageResult, String> {
    let png = clipboard_state.with_clipboard(|clipboard| {
        let image = match clipboard.get_image() {
            Ok(image) => image,
            Err(arboard::Error::ContentNotAvailable) => return Ok(None),
            Err(error) => return Err(format!("Failed to read clipboard image: {error}")),
        };
        encode_clipboard_rgba_as_png(image.width, image.height, image.bytes.as_ref()).map(Some)
    })?;
    let Some(png) = png else {
        return Ok(NativeClipboardImageResult {
            found: false,
            local_path: None,
        });
    };
    let directory = clipboard_image_staging_directory(app)?;
    prune_clipboard_image_cache(&directory, None)?;
    let path = directory.join(format!("clipboard-{}.png", Uuid::new_v4()));
    write_private_clipboard_image(&path, &png)?;
    if let Err(prune_error) = prune_clipboard_image_cache(&directory, Some(&path)) {
        return match std::fs::remove_file(&path) {
            Ok(()) => Err(prune_error),
            Err(remove_error) => Err(format!(
                "{prune_error}; failed to remove newly staged clipboard image: {remove_error}"
            )),
        };
    }
    Ok(NativeClipboardImageResult {
        found: true,
        local_path: Some(path.to_string_lossy().into_owned()),
    })
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
    let data = (|| {
        let metadata = std::fs::metadata(&safe_local_path)
            .map_err(|e| format!("Failed to inspect pasted image file: {}", e))?;
        if metadata.len() > MAX_CLIPBOARD_IMAGE_BYTES {
            return Err("Clipboard image exceeds 10 MiB".to_string());
        }
        std::fs::read(&safe_local_path)
            .map_err(|e| format!("Failed to read pasted image file: {}", e))
    })();
    std::fs::remove_file(&safe_local_path)
        .map_err(|e| format!("Failed to remove pasted image cache file: {}", e))?;
    let data = data?;

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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn read_clipboard_image(
    app: AppHandle,
    clipboard_state: State<'_, DesktopClipboardState>,
) -> Result<NativeClipboardImageResult, String> {
    read_desktop_clipboard_image(&app, &clipboard_state)
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> Result<NativeClipboardImageResult, String> {
    let directory = clipboard_image_staging_directory(&app)?;
    read_native_clipboard_image(&app, directory.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> Result<NativeClipboardImageResult, String> {
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
pub(crate) const MAX_SFTP_PREVIEW_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

/// Throttled progress emitter: reports at most ~1 MiB granularity plus the
/// final chunk so progress bars always complete.
pub(crate) fn make_download_progress_emitter(
    app: AppHandle,
    path: String,
    total: Option<u64>,
) -> impl Fn(u64) + Send + Sync {
    let last_emitted = std::sync::Mutex::new(0_u64);
    move |transferred: u64| {
        let should_emit = {
            let mut last = last_emitted.lock().unwrap_or_else(|p| p.into_inner());
            let crossed_mib = transferred >= *last + (1 << 20);
            let reached_total = total.is_some_and(|size| transferred >= size);
            // Unknown total (stat failed): still emit on advancement so the
            // bar keeps moving.
            let advanced = total.is_none() && transferred > *last;
            if crossed_mib || reached_total || advanced {
                *last = transferred;
                true
            } else {
                false
            }
        };
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

fn local_sftp_preview_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {}", e))?
        .join("sftp-preview");

    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to prepare preview cache dir: {}", e))?;
    Ok(base_dir)
}

pub(crate) fn ensure_local_sftp_preview_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = local_sftp_preview_dir(app)?;
    prune_stale_sftp_previews(&base_dir);
    Ok(base_dir)
}

fn resolve_existing_file_within(
    base_dir: &Path,
    candidate: &Path,
) -> Result<Option<PathBuf>, String> {
    if !candidate.starts_with(base_dir) {
        return Err("Preview cache path is outside the app cache".to_string());
    }
    let canonical_base = std::fs::canonicalize(base_dir)
        .map_err(|e| format!("Failed to access preview cache: {}", e))?;
    let canonical_candidate = match std::fs::canonicalize(candidate) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to access preview cache file: {}", error)),
    };
    if !canonical_candidate.starts_with(canonical_base) {
        return Err("Preview cache path is outside the app cache".to_string());
    }
    Ok(canonical_candidate.is_file().then_some(canonical_candidate))
}

pub(crate) fn resolve_sftp_preview_cache_file(
    app: &AppHandle,
    candidate: &Path,
) -> Result<Option<PathBuf>, String> {
    let base_dir = ensure_local_sftp_preview_dir(app)?;
    resolve_existing_file_within(&base_dir, candidate)
}

const SFTP_PREVIEW_PART_MAX_AGE_SECS: u64 = 60 * 60;
const SFTP_PREVIEW_MAX_AGE_SECS: u64 = 24 * 60 * 60;
static ACTIVE_PREVIEW_CACHE_FILES: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn prune_stale_sftp_previews(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let active = ACTIVE_PREVIEW_CACHE_FILES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if active.contains_key(&path) {
            continue;
        }
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
                .unwrap_or(false);
        let stale = age
            .map(|secs| secs > SFTP_PREVIEW_MAX_AGE_SECS)
            .unwrap_or(false);
        if stale_part || stale {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
pub fn preview_cache_acquire(app: AppHandle, local_path: String) -> Result<bool, String> {
    let candidate = PathBuf::from(local_path);
    if resolve_sftp_preview_cache_file(&app, &candidate)?.is_none() {
        return Ok(false);
    }
    let mut active = ACTIVE_PREVIEW_CACHE_FILES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *active.entry(candidate).or_insert(0) += 1;
    Ok(true)
}

#[tauri::command]
pub fn preview_cache_release(app: AppHandle, local_path: String) -> Result<(), String> {
    let base_dir = local_sftp_preview_dir(&app)?;
    let candidate = PathBuf::from(local_path);
    if !candidate.starts_with(&base_dir) {
        return Err("Preview cache path is outside the app cache".to_string());
    }
    let mut active = ACTIVE_PREVIEW_CACHE_FILES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(count) = active.get_mut(&candidate) {
        if *count > 1 {
            *count -= 1;
        } else {
            active.remove(&candidate);
        }
    }
    Ok(())
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
pub async fn sftp_write_file(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
    content: String,
    expected_content: String,
) -> Result<(), String> {
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;
    connection
        .write_file_via_sftp(
            &path,
            content.as_bytes(),
            expected_content.as_bytes(),
            MAX_SFTP_PREVIEW_READ_BYTES,
        )
        .await
        .map_err(|e| e.to_string())
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
    let safe_name = sanitize_file_name(file_name);

    let preview_dir = ensure_local_sftp_preview_dir(&app)?;
    let part_path = preview_dir.join(format!("{}-{}.part", Uuid::new_v4(), safe_name));
    let destination = preview_dir.join(format!("{}-{}", Uuid::new_v4(), safe_name));
    if !destination.starts_with(&preview_dir) || !part_path.starts_with(&preview_dir) {
        return Err("Invalid preview destination path".to_string());
    }

    let total = connection
        .file_size_via_sftp(&remote_path)
        .await
        .unwrap_or(None);
    let on_progress = make_download_progress_emitter(app.clone(), remote_path.clone(), total);
    let mut part_file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|error| format!("Failed to create preview download file: {error}"))?;
    let size = match connection
        .download_file_via_sftp(
            &remote_path,
            &mut part_file,
            MAX_SFTP_PREVIEW_DOWNLOAD_BYTES,
            Some(&on_progress),
        )
        .await
    {
        Ok(size) => size,
        Err(error) => {
            drop(part_file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(error.to_string());
        }
    };

    drop(part_file);
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

/// Read or write plain text through the native desktop clipboard.
// arboard has no Android/iOS implementation; the desktop shell owns these
// shortcuts, so mobile returns unavailable.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn read_clipboard_text(
    clipboard_state: State<'_, DesktopClipboardState>,
) -> Result<Option<String>, String> {
    clipboard_state.with_clipboard(|clipboard| {
        clipboard
            .get_text()
            .map(Some)
            .map_err(|error| format!("Failed to read clipboard: {error}"))
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn write_clipboard_text(
    clipboard_state: State<'_, DesktopClipboardState>,
    text: String,
) -> Result<(), String> {
    clipboard_state.with_clipboard(|clipboard| {
        clipboard
            .set_text(text)
            .map_err(|error| format!("Failed to write clipboard: {error}"))
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn read_clipboard_text() -> Result<Option<String>, String> {
    Err("Clipboard text is unavailable on this platform".to_string())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn write_clipboard_text(_text: String) -> Result<(), String> {
    Err("Clipboard text is unavailable on this platform".to_string())
}

#[tauri::command]
pub async fn sftp_home_dir(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<String, String> {
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;
    connection
        .home_dir_via_sftp()
        .await
        .map_err(|e| e.to_string())
}

/// Reject remote paths that could escape the browsed directory: the UI only
/// ever joins a validated leaf onto the currently listed path.
fn validate_sftp_browse_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.contains('\0')
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err("Invalid remote path".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_create_dir(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    validate_sftp_browse_path(&path)?;
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;
    connection
        .create_dir_via_sftp(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_create_file(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    validate_sftp_browse_path(&path)?;
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;
    connection
        .create_file_via_sftp(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove_path(
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    validate_sftp_browse_path(&path)?;
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;
    connection
        .remove_path_via_sftp(&path)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Strip characters that are invalid in destination file names on the
/// current host (separators, controls; on Windows also NTFS ADS characters
/// and reserved device names) so a remote or dialog-provided name can never
/// traverse. POSIX-legal characters such as ':' are preserved off-Windows.
pub(crate) fn sanitize_file_name(file_name: &str) -> String {
    let safe_name: String = file_name
        .chars()
        .filter(|c| !c.is_control() && !std::path::is_separator(*c))
        .collect();
    #[cfg(windows)]
    let safe_name: String = {
        let stripped: String = safe_name
            .chars()
            // ':' would form an NTFS alternate data stream.
            .filter(|c| !matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
            .collect();
        let stem = stripped.split('.').next().unwrap_or("").to_uppercase();
        if WINDOWS_RESERVED_NAMES.contains(&stem.as_str()) {
            format!("file-{}", stripped)
        } else {
            stripped
        }
    };
    if safe_name.is_empty() {
        "download".to_string()
    } else {
        safe_name
    }
}

/// Collision-safe destination candidates: the plain name first, then
/// "name (1)", "name (2)", … — claim_download_destination stops at the
/// first free name and errors out after the retry budget is exhausted.
pub(crate) fn unique_download_candidate_names(file_name: &str) -> impl Iterator<Item = String> {
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let extension = Path::new(file_name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    std::iter::once(file_name.to_string())
        .chain((1..1000u32).map(move |index| format!("{} ({}){}", stem, index, extension)))
}

/// Platform-neutral claimed destination: owns the exclusive write handle and
/// every handle needed to clean itself up safely if the download fails. A
/// concurrently re-pointed ancestor directory cannot redirect the download
/// or its cleanup to an unrelated file.
pub(crate) struct ClaimedDownloadDestination {
    path: PathBuf,
    file: tokio::fs::File,
    cleanup: ClaimedCleanup,
    armed: bool,
}

impl ClaimedDownloadDestination {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn file_mut(&mut self) -> &mut tokio::fs::File {
        &mut self.file
    }

    /// Remove the claimed file through pinned handles. Never falls back to
    /// pathname removal, so a re-pointed ancestor cannot make this delete an
    /// unrelated file.
    pub fn discard(&mut self) -> Result<(), String> {
        let result = match &self.cleanup {
            #[cfg(unix)]
            ClaimedCleanup::Unix(cleanup) => unlink_candidate_at(cleanup)
                .map_err(|e| format!("Failed to remove partial download: {e}")),
            #[cfg(windows)]
            ClaimedCleanup::Windows => mark_delete_by_handle(&self.file)
                .map_err(|e| format!("Failed to mark partial download for deletion: {e}")),
        };
        if result.is_ok() {
            self.armed = false;
        }
        result
    }

    /// Disarm cleanup and hand over the final destination path.
    pub fn commit(&mut self) -> PathBuf {
        self.armed = false;
        std::mem::take(&mut self.path)
    }
}

impl Drop for ClaimedDownloadDestination {
    fn drop(&mut self) {
        if self.armed {
            self.armed = false;
            let _ = self.discard();
        }
    }
}

pub(crate) fn append_cleanup_error(error: String, cleanup: Result<(), String>) -> String {
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => format!("{error}; {cleanup}"),
    }
}

#[cfg(unix)]
enum ClaimedCleanup {
    Unix(UnixClaimCleanup),
}

#[cfg(windows)]
enum ClaimedCleanup {
    Windows,
}

#[cfg(unix)]
struct UnixClaimCleanup {
    dir: std::fs::File,
    name: std::ffi::CString,
}

#[cfg(unix)]
fn open_download_dir(dir: &Path) -> std::io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    let path = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "download directory contains NUL",
        )
    })?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn open_candidate_at(
    dir: &std::fs::File,
    name: &std::ffi::CString,
) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn unlink_candidate_at(cleanup: &UnixClaimCleanup) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let rc = unsafe { libc::unlinkat(cleanup.dir.as_raw_fd(), cleanup.name.as_ptr(), 0) };
    if rc == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(windows)]
fn final_path_by_handle(file: &impl AsRawHandle) -> std::io::Result<PathBuf> {
    let mut buffer = vec![0_u16; 512];
    loop {
        let written = unsafe {
            GetFinalPathNameByHandleW(
                HANDLE(file.as_raw_handle()),
                &mut buffer,
                GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0),
            )
        } as usize;
        if written == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if written < buffer.len() {
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..written],
            )));
        }
        buffer.resize(written.saturating_add(1), 0);
    }
}

#[cfg(windows)]
fn mark_delete_by_handle(file: &impl AsRawHandle) -> std::io::Result<()> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            std::ptr::from_ref(&info).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    }
    .map_err(|error| std::io::Error::other(error.to_string()))
}

#[cfg(windows)]
fn open_windows_dir(dir: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(dir)
}

#[cfg(windows)]
fn open_windows_candidate(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode((GENERIC_WRITE.0 | DELETE.0) as u32)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .open(path)
}

#[cfg(windows)]
fn same_parent(file_real: &Path, canonical_dir: &Path) -> bool {
    file_real
        .parent()
        .is_some_and(|parent| parent.components().eq(canonical_dir.components()))
}

#[cfg(unix)]
pub(crate) fn claim_download_destination(
    dir: &Path,
    file_name: &str,
) -> Result<ClaimedDownloadDestination, String> {
    let dir_file =
        open_download_dir(dir).map_err(|e| format!("Failed to open download directory: {e}"))?;
    for name in unique_download_candidate_names(file_name) {
        let name_c = match std::ffi::CString::new(name.as_bytes().to_vec()) {
            Ok(name_c) => name_c,
            Err(_) => continue,
        };
        match open_candidate_at(&dir_file, &name_c) {
            Ok(file) => {
                return Ok(ClaimedDownloadDestination {
                    path: dir.join(&name),
                    file: tokio::fs::File::from_std(file),
                    cleanup: ClaimedCleanup::Unix(UnixClaimCleanup {
                        dir: dir_file,
                        name: name_c,
                    }),
                    armed: true,
                });
            }
            Err(e) if e.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(e) => return Err(format!("Failed to prepare download destination: {e}")),
        }
    }
    Err("No available download file name".into())
}

#[cfg(windows)]
pub(crate) fn claim_download_destination(
    dir: &Path,
    file_name: &str,
) -> Result<ClaimedDownloadDestination, String> {
    let dir_file =
        open_windows_dir(dir).map_err(|e| format!("Failed to open download directory: {e}"))?;
    let canonical_dir = final_path_by_handle(&dir_file)
        .map_err(|e| format!("Failed to resolve download directory: {e}"))?;
    for name in unique_download_candidate_names(file_name) {
        let path = dir.join(&name);
        match open_windows_candidate(&path) {
            Ok(file) => {
                let verification_error = match final_path_by_handle(&file) {
                    Ok(real) if same_parent(&real, &canonical_dir) => None,
                    Ok(_) => Some("Download destination changed during claim".to_string()),
                    Err(e) => Some(format!("Failed to verify download destination: {e}")),
                };
                if let Some(mut error) = verification_error {
                    if let Err(cleanup) = mark_delete_by_handle(&file) {
                        error.push_str(&format!("; cleanup failed: {cleanup}"));
                    }
                    drop(file);
                    return Err(error);
                }
                return Ok(ClaimedDownloadDestination {
                    path,
                    file: tokio::fs::File::from_std(file),
                    cleanup: ClaimedCleanup::Windows,
                    armed: true,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to prepare download destination: {e}")),
        }
    }
    Err("No available download file name".into())
}

/// Explicit user download: stream the remote file into a user-chosen
/// directory (defaults to Downloads) under its own name. No size cap — the
/// user picked the file.
#[tauri::command]
pub async fn sftp_download_to_dir(
    app: AppHandle,
    session_manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    remote_path: String,
    destination_path: Option<String>,
) -> Result<SftpDownloadedFile, String> {
    let connection = sftp_connection_for_session(&session_manager, &session_id).await?;

    let remote_base = remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let destination_path = match destination_path.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(path) if path.is_empty() => {
            return Err("Invalid download destination path".to_string())
        }
        Some(path) => PathBuf::from(path),
        None => {
            let dir = app
                .path()
                .download_dir()
                .map_err(|e| format!("Failed to resolve Downloads directory: {}", e))?;
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to prepare download directory: {}", e))?;
            dir.join(sanitize_file_name(remote_base))
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

    let total = connection
        .file_size_via_sftp(&remote_path)
        .await
        .unwrap_or(None);
    let on_progress = make_download_progress_emitter(app.clone(), remote_path.clone(), total);
    let size = match connection
        .download_file_via_sftp(
            &remote_path,
            claimed.file_mut(),
            u64::MAX,
            Some(&on_progress),
        )
        .await
    {
        Ok(size) => size,
        Err(error) => {
            let cleanup = claimed.discard();
            return Err(append_cleanup_error(error.to_string(), cleanup));
        }
    };
    let destination = claimed.commit();

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
    fn preview_cache_scope_accepts_only_files_inside_base() {
        let root =
            std::env::temp_dir().join(format!("redterm-preview-cache-scope-{}", Uuid::new_v4()));
        let base = root.join("cache");
        std::fs::create_dir_all(&base).expect("preview cache test dir should be created");
        let inside = base.join("preview.mp4");
        let outside = root.join("outside.mp4");
        std::fs::write(&inside, b"inside").expect("inside file should be created");
        std::fs::write(&outside, b"outside").expect("outside file should be created");

        let resolved = resolve_existing_file_within(&base, &inside)
            .expect("inside cache file should be accepted")
            .expect("inside cache file should exist");
        assert_eq!(resolved, std::fs::canonicalize(&inside).unwrap());
        assert!(resolve_existing_file_within(&base, &outside).is_err());

        std::fs::remove_dir_all(root).expect("preview cache test dir should be removed");
    }

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
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_clipboard_rgba_is_encoded_as_valid_png() {
        use std::io::Write;

        let png = encode_clipboard_rgba_as_png(1, 1, &[255, 0, 0, 255])
            .expect("RGBA clipboard pixel should encode");
        assert_eq!(detect_image_extension(&png), Some("png"));
        assert!(encode_clipboard_rgba_as_png(2, 1, &[255, 0, 0, 255]).is_err());

        let oversized_dimensions =
            encode_clipboard_rgba_as_png(MAX_CLIPBOARD_IMAGE_PIXELS + 1, 1, &[])
                .expect_err("oversized dimensions should be rejected before encoding");
        assert!(oversized_dimensions.contains("32-megapixel"));

        let mut limited_writer = ClipboardPngWriter {
            bytes: Vec::new(),
            limit: 4,
        };
        assert!(limited_writer.write_all(&[0; 5]).is_err());
        assert!(limited_writer.bytes.is_empty());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_clipboard_cache_enforces_file_count_independently() {
        let directory = std::env::temp_dir().join(format!(
            "redterm-clipboard-cache-file-count-{}",
            Uuid::new_v4()
        ));
        prepare_clipboard_image_staging_directory(&directory)
            .expect("clipboard cache test dir should be created");
        let newest = directory.join("newest.png");
        let middle = directory.join("middle.png");
        let oldest = directory.join("oldest.png");
        for path in [&newest, &middle, &oldest] {
            write_private_clipboard_image(path, &[1]).expect("clipboard image should be written");
        }

        let now = std::time::SystemTime::now();
        for (path, age) in [(&newest, 1), (&middle, 2), (&oldest, 3)] {
            let file = std::fs::File::open(path).expect("clipboard image should open");
            file.set_times(std::fs::FileTimes::new().set_modified(now - Duration::from_secs(age)))
                .expect("clipboard image time should be set");
        }

        prune_clipboard_image_cache_with_limits(
            &directory,
            None,
            now,
            Duration::from_secs(60),
            2,
            u64::MAX,
        )
        .expect("clipboard cache should enforce file count");

        assert!(newest.exists());
        assert!(middle.exists());
        assert!(!oldest.exists());
        std::fs::remove_dir_all(directory).expect("clipboard cache test dir should be removed");
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_clipboard_cache_enforces_byte_limit_independently() {
        let directory = std::env::temp_dir().join(format!(
            "redterm-clipboard-cache-byte-limit-{}",
            Uuid::new_v4()
        ));
        prepare_clipboard_image_staging_directory(&directory)
            .expect("clipboard cache test dir should be created");
        let newest = directory.join("newest.png");
        let older = directory.join("older.png");
        write_private_clipboard_image(&newest, &[1; 4])
            .expect("newest clipboard image should be written");
        write_private_clipboard_image(&older, &[2; 3])
            .expect("older clipboard image should be written");

        let now = std::time::SystemTime::now();
        for (path, age) in [(&newest, 1), (&older, 2)] {
            let file = std::fs::File::open(path).expect("clipboard image should open");
            file.set_times(std::fs::FileTimes::new().set_modified(now - Duration::from_secs(age)))
                .expect("clipboard image time should be set");
        }

        prune_clipboard_image_cache_with_limits(
            &directory,
            None,
            now,
            Duration::from_secs(60),
            usize::MAX,
            4,
        )
        .expect("clipboard cache should enforce byte limit");

        assert!(newest.exists());
        assert!(!older.exists());
        std::fs::remove_dir_all(directory).expect("clipboard cache test dir should be removed");
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_clipboard_cache_is_private_bounded_and_preserves_new_file() {
        let directory =
            std::env::temp_dir().join(format!("redterm-clipboard-cache-policy-{}", Uuid::new_v4()));
        prepare_clipboard_image_staging_directory(&directory)
            .expect("clipboard cache test dir should be created");
        let protected = directory.join("protected.png");
        let expired = directory.join("expired.png");
        let newest = directory.join("newest.png");
        let over_budget = directory.join("over-budget.png");
        write_private_clipboard_image(&protected, &[1; 4])
            .expect("protected image should be written");
        write_private_clipboard_image(&expired, &[2]).expect("expired image should be written");
        write_private_clipboard_image(&newest, &[3; 2]).expect("newest image should be written");
        write_private_clipboard_image(&over_budget, &[4; 3])
            .expect("over-budget image should be written");

        let now = std::time::SystemTime::now();
        let stale_time = now - Duration::from_secs(120);
        for path in [&protected, &expired] {
            let file = std::fs::File::open(path).expect("stale image should open");
            file.set_times(std::fs::FileTimes::new().set_modified(stale_time))
                .expect("stale image time should be set");
        }
        let over_budget_file =
            std::fs::File::open(&over_budget).expect("over-budget image should open");
        over_budget_file
            .set_times(std::fs::FileTimes::new().set_modified(now - Duration::from_secs(1)))
            .expect("over-budget image time should be set");

        prune_clipboard_image_cache_with_limits(
            &directory,
            Some(&protected),
            now,
            Duration::from_secs(60),
            2,
            6,
        )
        .expect("clipboard cache should be pruned");

        assert!(protected.exists());
        assert!(newest.exists());
        assert!(!expired.exists());
        assert!(!over_budget.exists());
        let retained = std::fs::read_dir(&directory)
            .expect("clipboard cache should be readable")
            .count();
        assert_eq!(retained, 2);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&directory)
                    .expect("clipboard cache dir metadata should exist")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&protected)
                    .expect("clipboard image metadata should exist")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        std::fs::remove_dir_all(directory).expect("clipboard cache test dir should be removed");
    }

    #[test]
    fn stale_preview_pruning_keeps_leased_files_until_release() {
        let dir =
            std::env::temp_dir().join(format!("redterm-preview-cache-lease-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("preview test dir should be created");
        let path = dir.join("active-preview.pdf");
        let file = std::fs::File::create(&path).expect("preview test file should be created");
        file.set_times(std::fs::FileTimes::new().set_modified(
            std::time::SystemTime::now() - Duration::from_secs(SFTP_PREVIEW_MAX_AGE_SECS + 1),
        ))
        .expect("preview test file should become stale");

        ACTIVE_PREVIEW_CACHE_FILES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(path.clone(), 1);
        prune_stale_sftp_previews(&dir);
        assert!(path.exists());

        ACTIVE_PREVIEW_CACHE_FILES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&path);
        prune_stale_sftp_previews(&dir);
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).expect("preview test dir should be removed");
    }

    #[cfg(not(windows))]
    #[test]
    fn sanitizer_preserves_posix_legal_characters_off_windows() {
        assert_eq!(sanitize_file_name("a:b.txt"), "a:b.txt");
        assert_eq!(sanitize_file_name("report*final?"), "report*final?");
        assert_eq!(sanitize_file_name("con"), "con");
        assert_eq!(sanitize_file_name("bad/name"), "badname");
        assert_eq!(sanitize_file_name("a\u{7f}b"), "ab");
    }

    #[cfg(windows)]
    #[test]
    fn sanitizer_strips_windows_invalid_characters_and_reserved_names() {
        assert_eq!(sanitize_file_name("a:b.txt"), "ab.txt");
        assert_eq!(sanitize_file_name("report*final?"), "reportfinal");
        assert_eq!(sanitize_file_name("con"), "file-con");
        assert_eq!(sanitize_file_name("con.txt"), "file-con.txt");
        assert_eq!(sanitize_file_name("bad/name"), "badname");
        assert_eq!(sanitize_file_name(":"), "download");
    }

    #[test]
    fn sftp_browse_path_validation_rejects_traversal_and_relative_paths() {
        assert!(validate_sftp_browse_path("/home/user").is_ok());
        assert!(validate_sftp_browse_path("/").is_ok());
        assert!(validate_sftp_browse_path("home/user").is_err());
        assert!(validate_sftp_browse_path("").is_err());
        assert!(validate_sftp_browse_path("/a/../b").is_err());
        assert!(validate_sftp_browse_path("/a/./b").is_err());
        assert!(validate_sftp_browse_path("/a/\0b").is_err());
    }
}

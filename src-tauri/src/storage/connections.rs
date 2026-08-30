use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_name: Option<String>,
    #[serde(default)]
    pub has_saved_password: bool,
    #[serde(default)]
    pub use_keyboard_interactive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_script_ready_text: Option<String>,
}
const MANAGED_SSH_KEY_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ManagedSshKeyMetadata {
    version: u8,
    key_id: String,
    file_name: String,
    host: String,
    port: u16,
    username: String,
}

impl ManagedSshKeyMetadata {
    fn matches_target(&self, host: &str, port: u16, username: &str) -> bool {
        self.version == MANAGED_SSH_KEY_VERSION
            && self.host == normalize_credential_host(host)
            && self.port == port
            && self.username == username
    }
}

const STORED_CREDENTIAL_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct StoredCredential {
    version: u8,
    connection_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
}

impl StoredCredential {
    fn new(connection: &SavedConnection, password: String) -> Self {
        Self {
            version: STORED_CREDENTIAL_VERSION,
            connection_id: connection.id.clone(),
            host: normalize_credential_host(&connection.host),
            port: connection.port,
            username: connection.username.clone(),
            password,
        }
    }

    fn matches(&self, connection: &SavedConnection) -> bool {
        self.version == STORED_CREDENTIAL_VERSION
            && self.connection_id == connection.id
            && self.host == normalize_credential_host(&connection.host)
            && self.port == connection.port
            && self.username == connection.username
    }
}

fn normalize_credential_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionsStore {
    pub connections: Vec<SavedConnection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadedSshKeyResult {
    pub key_id: String,
    pub file_name: String,
}

const PUBLIC_KEY_UPLOAD_ERROR: &str =
    "Please choose a private key file. Public keys cannot be used for SSH authentication.";
const MAX_SSH_KEY_BYTES: usize = 1024 * 1024;
const MAX_MANAGED_SSH_KEYS: usize = 20;
const MAX_MANAGED_SSH_KEY_BYTES: u64 = 20 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 100;
const MAX_CONNECTION_STORE_BYTES: usize = 1024 * 1024;
const MAX_CONNECTION_ID_BYTES: usize = 64;
const MAX_CONNECTION_NAME_BYTES: usize = 256;
const MAX_HOST_BYTES: usize = 253;
const MAX_USERNAME_BYTES: usize = 256;
const MAX_STARTUP_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_SAVED_PASSWORD_BYTES: usize = 64 * 1024;
static SSH_KEY_STORE_LOCK: Mutex<()> = Mutex::new(());
static CONNECTION_STORE_LOCK: Mutex<()> = Mutex::new(());

fn is_public_ssh_key_algorithm(algorithm: &str) -> bool {
    let base_algorithm = algorithm
        .strip_suffix("-cert-v01@openssh.com")
        .unwrap_or(algorithm);

    matches!(
        base_algorithm,
        "ssh-ed25519"
            | "ssh-rsa"
            | "ssh-dss"
            | "rsa-sha2-256"
            | "rsa-sha2-512"
            | "sk-ssh-ed25519@openssh.com"
    ) || base_algorithm.starts_with("ecdsa-sha2-")
        || base_algorithm.starts_with("sk-ecdsa-sha2-")
}

fn is_public_ssh_key_content(data: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(data) else {
        return false;
    };

    let first_meaningful_line = text
        .lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("");

    if first_meaningful_line.starts_with("-----BEGIN ") {
        return first_meaningful_line.ends_with(" PUBLIC KEY-----");
    }

    let algorithm = first_meaningful_line
        .split_whitespace()
        .next()
        .unwrap_or("");
    is_public_ssh_key_algorithm(algorithm)
}

// Get app data directory from Tauri
fn get_app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CREDENTIAL_SERVICE: &str = "com.coderred.redterm.saved-connections";

#[cfg(target_os = "android")]
fn store_secure_value(app: &AppHandle, connection_id: &str, value: &str) -> Result<(), String> {
    tauri_plugin_redterm_android_paste::store_credential(
        app,
        connection_id.to_string(),
        value.to_string(),
    )
}

#[cfg(target_os = "ios")]
fn store_secure_value(app: &AppHandle, connection_id: &str, value: &str) -> Result<(), String> {
    tauri_plugin_redterm_ios_native::store_credential(
        app,
        connection_id.to_string(),
        value.to_string(),
    )
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn store_secure_value(_app: &AppHandle, connection_id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, connection_id)
        .and_then(|entry| entry.set_password(value))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn load_secure_value(app: &AppHandle, connection_id: &str) -> Result<Option<String>, String> {
    tauri_plugin_redterm_android_paste::get_credential(app, connection_id.to_string())
}

#[cfg(target_os = "ios")]
fn load_secure_value(app: &AppHandle, connection_id: &str) -> Result<Option<String>, String> {
    tauri_plugin_redterm_ios_native::get_credential(app, connection_id.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn load_secure_value(_app: &AppHandle, connection_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, connection_id)
        .map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(target_os = "android")]
fn delete_secure_value(app: &AppHandle, connection_id: &str) -> Result<(), String> {
    tauri_plugin_redterm_android_paste::delete_credential(app, connection_id.to_string())
}

#[cfg(target_os = "ios")]
fn delete_secure_value(app: &AppHandle, connection_id: &str) -> Result<(), String> {
    tauri_plugin_redterm_ios_native::delete_credential(app, connection_id.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn delete_secure_value(_app: &AppHandle, connection_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(CREDENTIAL_SERVICE, connection_id)
        .map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn store_secure_password(
    app: &AppHandle,
    connection_id: &str,
    credential: &StoredCredential,
) -> Result<(), String> {
    let value = serde_json::to_string(credential).map_err(|error| error.to_string())?;
    store_secure_value(app, connection_id, &value)
}

fn load_secure_password(
    app: &AppHandle,
    connection_id: &str,
) -> Result<Option<StoredCredential>, String> {
    let Some(value) = load_secure_value(app, connection_id)? else {
        return Ok(None);
    };
    serde_json::from_str(&value).map(Some).map_err(|_| {
        "Saved credential metadata is invalid. Please re-enter the password.".to_string()
    })
}

fn delete_secure_password(app: &AppHandle, connection_id: &str) -> Result<(), String> {
    delete_secure_value(app, connection_id)
}

fn restore_secure_password(
    app: &AppHandle,
    connection_id: &str,
    previous_credential: Option<&StoredCredential>,
) -> Result<(), String> {
    match previous_credential {
        Some(credential) => store_secure_password(app, connection_id, credential),
        None => delete_secure_password(app, connection_id),
    }
}

impl ConnectionsStore {
    fn get_config_path(app: &AppHandle) -> PathBuf {
        let config_dir = get_app_data_dir(app);
        fs::create_dir_all(&config_dir).ok();
        config_dir.join("connections.json")
    }

    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let path = Self::get_config_path(app);
        let store = if path.exists() {
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            if metadata.len() > MAX_CONNECTION_STORE_BYTES as u64 {
                return Err("Saved connection storage exceeds 1 MiB".to_string());
            }
            let json = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            serde_json::from_str(&json).map_err(|error| error.to_string())?
        } else {
            Self::default()
        };
        validate_connection_store(&store)?;

        Ok(store)
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = Self::get_config_path(app);
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        if json.len() > MAX_CONNECTION_STORE_BYTES {
            return Err("Saved connection storage exceeds 1 MiB".to_string());
        }

        #[cfg(unix)]
        {
            if path.exists() {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&path)
                .map_err(|e| e.to_string())?;
            file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }

        #[cfg(not(unix))]
        fs::write(&path, json).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn add_connection(&mut self, conn: SavedConnection) {
        self.connections.retain(|c| c.id != conn.id);
        self.connections.push(conn);
    }

    pub fn remove_connection(&mut self, id: &str) {
        self.connections.retain(|c| c.id != id);
    }
}

fn sanitize_file_name(file_name: &str) -> String {
    let sanitized: String = file_name
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => ch,
            _ => '_',
        })
        .collect();

    let trimmed = sanitized.trim_matches('_').trim_matches('.');
    if trimmed.is_empty() {
        "ssh-key".to_string()
    } else {
        trimmed.to_string()
    }
}

fn get_ssh_keys_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_app_data_dir(app).join("ssh-keys");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::canonicalize(dir).map_err(|e| e.to_string())
}

fn validate_managed_ssh_key_id(key_id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(key_id)
        .map_err(|_| "Invalid managed SSH key identifier".to_string())?;
    if parsed.to_string() != key_id {
        return Err("Invalid managed SSH key identifier".to_string());
    }
    Ok(())
}

fn managed_ssh_key_path(keys_dir: &Path, key_id: &str) -> Result<PathBuf, String> {
    validate_managed_ssh_key_id(key_id)?;
    Ok(keys_dir.join(format!("{key_id}.key")))
}

fn managed_ssh_key_metadata_path(keys_dir: &Path, key_id: &str) -> Result<PathBuf, String> {
    validate_managed_ssh_key_id(key_id)?;
    Ok(keys_dir.join(format!("{key_id}.json")))
}

fn resolve_managed_ssh_key_path(
    keys_dir: &Path,
    key_id: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Result<PathBuf, String> {
    let canonical_keys_dir = fs::canonicalize(keys_dir).map_err(|e| e.to_string())?;
    let candidate = managed_ssh_key_path(&canonical_keys_dir, key_id)?;
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "Managed SSH key is unavailable".to_string(),
        _ => error.to_string(),
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Managed SSH key is not a regular file".to_string());
    }

    let metadata_path = managed_ssh_key_metadata_path(&canonical_keys_dir, key_id)?;
    let metadata_bytes = fs::read(&metadata_path)
        .map_err(|_| "Managed SSH key metadata is unavailable".to_string())?;
    if metadata_bytes.len() > 4096 {
        return Err("Managed SSH key metadata is invalid".to_string());
    }
    let key_metadata: ManagedSshKeyMetadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|_| "Managed SSH key metadata is invalid".to_string())?;
    if key_metadata.key_id != key_id || !key_metadata.matches_target(host, port, username) {
        return Err(
            "Managed SSH key does not match this host, port, and username. Please select the key again."
                .to_string(),
        );
    }

    let canonical_candidate = fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if canonical_candidate.parent() != Some(canonical_keys_dir.as_path()) {
        return Err("Managed SSH key is outside the managed key directory".to_string());
    }
    Ok(canonical_candidate)
}

fn managed_ssh_key_usage(keys_dir: &Path) -> Result<(usize, u64), String> {
    let mut key_count = 0;
    let mut total_bytes = 0_u64;
    for entry in fs::read_dir(keys_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("Managed SSH key directory contains an invalid entry".to_string());
        }
        match path.extension().and_then(|value| value.to_str()) {
            Some("key") => key_count += 1,
            Some("json") => {}
            _ => return Err("Managed SSH key directory contains an invalid entry".to_string()),
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
    }
    Ok((key_count, total_bytes))
}

fn delete_managed_ssh_key_file(app: &AppHandle, key_id: &str) -> Result<(), String> {
    let _guard = SSH_KEY_STORE_LOCK
        .lock()
        .map_err(|_| "Managed SSH key store lock was poisoned".to_string())?;
    let keys_dir = get_ssh_keys_dir(app)?;
    let key_path = managed_ssh_key_path(&keys_dir, key_id)?;
    let metadata_path = managed_ssh_key_metadata_path(&keys_dir, key_id)?;
    for path in [key_path, metadata_path] {
        match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_file() && !metadata.file_type().is_symlink() =>
            {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            Ok(_) => return Err("Managed SSH key is not a regular file".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn store_uploaded_ssh_key(
    keys_dir: &Path,
    file_name: &str,
    data: &[u8],
    host: &str,
    port: u16,
    username: &str,
) -> Result<UploadedSshKeyResult, String> {
    if data.is_empty() {
        return Err("SSH key file is empty".to_string());
    }
    if data.len() > MAX_SSH_KEY_BYTES {
        return Err("SSH key file exceeds 1 MiB".to_string());
    }
    if file_name.len() > 255 {
        return Err("SSH key file name is too long".to_string());
    }
    if host.trim().is_empty()
        || host.len() > MAX_HOST_BYTES
        || username.trim().is_empty()
        || username.len() > MAX_USERNAME_BYTES
    {
        return Err("SSH key target metadata is invalid".to_string());
    }
    if is_public_ssh_key_content(data) {
        return Err(PUBLIC_KEY_UPLOAD_ERROR.to_string());
    }

    let safe_name = sanitize_file_name(file_name);
    let key_id = uuid::Uuid::new_v4().to_string();
    let key_metadata = ManagedSshKeyMetadata {
        version: MANAGED_SSH_KEY_VERSION,
        key_id: key_id.clone(),
        file_name: safe_name.clone(),
        host: normalize_credential_host(host),
        port,
        username: username.to_string(),
    };
    let metadata_bytes = serde_json::to_vec(&key_metadata).map_err(|error| error.to_string())?;
    let (key_count, total_bytes) = managed_ssh_key_usage(keys_dir)?;
    if key_count >= MAX_MANAGED_SSH_KEYS
        || total_bytes
            .saturating_add(data.len() as u64)
            .saturating_add(metadata_bytes.len() as u64)
            > MAX_MANAGED_SSH_KEY_BYTES
    {
        return Err("Managed SSH key storage limit reached".to_string());
    }

    let key_path = managed_ssh_key_path(keys_dir, &key_id)?;
    let metadata_path = managed_ssh_key_metadata_path(keys_dir, &key_id)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut key_file = options.open(&key_path).map_err(|e| e.to_string())?;
    if let Err(error) = key_file.write_all(data) {
        drop(key_file);
        let _ = fs::remove_file(&key_path);
        return Err(error.to_string());
    }
    drop(key_file);

    let mut metadata_options = OpenOptions::new();
    metadata_options.write(true).create_new(true);
    #[cfg(unix)]
    metadata_options.mode(0o600);
    let metadata_result = metadata_options
        .open(&metadata_path)
        .and_then(|mut file| file.write_all(&metadata_bytes));
    if let Err(error) = metadata_result {
        let _ = fs::remove_file(&key_path);
        let _ = fs::remove_file(&metadata_path);
        return Err(error.to_string());
    }

    Ok(UploadedSshKeyResult {
        key_id,
        file_name: safe_name,
    })
}

#[tauri::command]
pub fn upload_ssh_key(
    app: AppHandle,
    file_name: String,
    data: Vec<u8>,
    host: String,
    port: u16,
    username: String,
) -> Result<UploadedSshKeyResult, String> {
    let _guard = SSH_KEY_STORE_LOCK
        .lock()
        .map_err(|_| "Managed SSH key store lock was poisoned".to_string())?;
    let keys_dir = get_ssh_keys_dir(&app)?;
    store_uploaded_ssh_key(&keys_dir, &file_name, &data, &host, port, &username)
}

#[tauri::command]
pub fn delete_uploaded_ssh_key(app: AppHandle, key_id: String) -> Result<(), String> {
    delete_managed_ssh_key_file(&app, &key_id)
}

fn validate_saved_connection(
    connection: &SavedConnection,
    password: Option<&str>,
) -> Result<(), String> {
    let parsed_id = uuid::Uuid::parse_str(&connection.id)
        .map_err(|_| "Connection identifier is invalid".to_string())?;
    if parsed_id.to_string() != connection.id || connection.id.len() > MAX_CONNECTION_ID_BYTES {
        return Err("Connection identifier is invalid".to_string());
    }
    if connection.name.trim().is_empty()
        || connection.name.len() > MAX_CONNECTION_NAME_BYTES
        || connection.host.trim().is_empty()
        || connection.host.len() > MAX_HOST_BYTES
        || connection.username.trim().is_empty()
        || connection.username.len() > MAX_USERNAME_BYTES
    {
        return Err("Connection metadata exceeds the allowed size".to_string());
    }
    if connection
        .startup_script
        .as_ref()
        .is_some_and(|value| value.len() > MAX_STARTUP_SCRIPT_BYTES)
        || connection
            .startup_script_ready_text
            .as_ref()
            .is_some_and(|value| value.len() > MAX_STARTUP_SCRIPT_BYTES)
    {
        return Err("Startup script exceeds 64 KiB".to_string());
    }
    match (&connection.key_id, &connection.key_name) {
        (Some(_), Some(name)) if name.len() <= 255 && sanitize_file_name(name) == *name => {}
        (None, None) => {}
        _ => return Err("Managed SSH key metadata is invalid".to_string()),
    }
    if password.is_some_and(|value| value.len() > MAX_SAVED_PASSWORD_BYTES) {
        return Err("Saved password exceeds 64 KiB".to_string());
    }
    Ok(())
}

fn validate_connection_store(store: &ConnectionsStore) -> Result<(), String> {
    if store.connections.len() > MAX_CONNECTIONS {
        return Err("Saved connection limit reached".to_string());
    }
    let serialized = serde_json::to_vec(store).map_err(|error| error.to_string())?;
    if serialized.len() > MAX_CONNECTION_STORE_BYTES {
        return Err("Saved connection storage exceeds 1 MiB".to_string());
    }
    Ok(())
}
fn managed_key_is_referenced(store: &ConnectionsStore, key_id: &str) -> bool {
    store
        .connections
        .iter()
        .any(|connection| connection.key_id.as_deref() == Some(key_id))
}

fn should_delete_managed_key(
    store: &ConnectionsStore,
    key_id: &str,
    preserve_managed_key: bool,
) -> bool {
    !preserve_managed_key && !managed_key_is_referenced(store, key_id)
}

// Tauri commands for connections
#[tauri::command]
pub fn load_connections(app: AppHandle) -> Result<Vec<SavedConnection>, String> {
    Ok(ConnectionsStore::load(&app)?.connections)
}

#[tauri::command]
pub fn save_connection(
    app: AppHandle,
    mut connection: SavedConnection,
    password: Option<String>,
) -> Result<(), String> {
    let _guard = CONNECTION_STORE_LOCK
        .lock()
        .map_err(|_| "Connection store lock was poisoned".to_string())?;
    if password.as_ref().is_some_and(|value| !value.is_empty()) {
        connection.has_saved_password = true;
    }
    validate_saved_connection(&connection, password.as_deref())?;

    if let Some(key_id) = connection.key_id.as_deref() {
        let keys_dir = get_ssh_keys_dir(&app)?;
        resolve_managed_ssh_key_path(
            &keys_dir,
            key_id,
            &connection.host,
            connection.port,
            &connection.username,
        )?;
    }

    let connection_id = connection.id.clone();
    let store = ConnectionsStore::load(&app)?;
    let existing_connection = store
        .connections
        .iter()
        .find(|stored| stored.id == connection_id);
    if existing_connection.is_none() && store.connections.len() >= MAX_CONNECTIONS {
        return Err("Saved connection limit reached".to_string());
    }
    let existing_key_id = existing_connection.and_then(|stored| stored.key_id.clone());
    let previous_credential = if existing_connection.is_some_and(|stored| stored.has_saved_password)
    {
        load_secure_password(&app, &connection_id)?
    } else {
        None
    };

    let mut candidate_store = store.clone();
    candidate_store.add_connection(connection.clone());
    validate_connection_store(&candidate_store)?;

    match password {
        Some(password) if !password.is_empty() => {
            let credential = StoredCredential::new(&connection, password);
            store_secure_password(&app, &connection_id, &credential)?;
        }
        Some(_) => return Err("Saved password cannot be empty".to_string()),
        None if connection.has_saved_password && previous_credential.is_none() => {
            return Err("A password is required to enable secure password storage".to_string());
        }
        None if connection.has_saved_password => {
            let credential = previous_credential.as_ref().ok_or_else(|| {
                "Saved password is unavailable in the platform credential store".to_string()
            })?;
            if !credential.matches(&connection) {
                return Err(
                    "Saved credential does not match this host, port, and username. Please re-enter the password."
                        .to_string(),
                );
            }
        }
        None if previous_credential.is_some() => {
            delete_secure_password(&app, &connection_id)?;
        }
        None => {}
    }

    if let Err(save_error) = candidate_store.save(&app) {
        let rollback_error =
            restore_secure_password(&app, &connection_id, previous_credential.as_ref()).err();
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("Failed to save connection: {save_error}; credential rollback failed: {rollback_error}")
            }
            None => save_error,
        });
    }

    if let Some(old_key_id) = existing_key_id {
        let old_key_still_referenced = managed_key_is_referenced(&candidate_store, &old_key_id);
        if connection.key_id.as_deref() != Some(old_key_id.as_str()) && !old_key_still_referenced {
            delete_managed_ssh_key_file(&app, &old_key_id)?;
        }
    }

    Ok(())
}

pub(crate) fn load_saved_password_for_connection(
    app: &AppHandle,
    connection_id: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Result<String, String> {
    let store = ConnectionsStore::load(app)?;
    let connection = store
        .connections
        .iter()
        .find(|stored| stored.id == connection_id)
        .ok_or_else(|| "Saved connection is unavailable".to_string())?;
    if !connection.has_saved_password {
        return Err("Saved password is unavailable".to_string());
    }
    if normalize_credential_host(&connection.host) != normalize_credential_host(host)
        || connection.port != port
        || connection.username != username
    {
        return Err(
            "Saved credential does not match this host, port, and username. Please re-enter the password."
                .to_string(),
        );
    }

    let credential = load_secure_password(app, connection_id)?.ok_or_else(|| {
        "Saved password is unavailable in the platform credential store".to_string()
    })?;
    if !credential.matches(connection) {
        return Err(
            "Saved credential does not match this host, port, and username. Please re-enter the password."
                .to_string(),
        );
    }
    Ok(credential.password)
}

pub(crate) fn resolve_uploaded_key_for_auth(
    app: &AppHandle,
    key_id: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Result<String, String> {
    let keys_dir = get_ssh_keys_dir(app)?;
    Ok(
        resolve_managed_ssh_key_path(&keys_dir, key_id, host, port, username)?
            .to_string_lossy()
            .into_owned(),
    )
}

#[tauri::command]
pub fn delete_connection(
    app: AppHandle,
    id: String,
    preserve_managed_key: bool,
) -> Result<(), String> {
    let _guard = CONNECTION_STORE_LOCK
        .lock()
        .map_err(|_| "Connection store lock was poisoned".to_string())?;
    let mut store = ConnectionsStore::load(&app)?;
    let existing_connection = store
        .connections
        .iter()
        .find(|connection| connection.id == id);
    let key_id = existing_connection.and_then(|connection| connection.key_id.clone());
    let previous_credential =
        if existing_connection.is_some_and(|connection| connection.has_saved_password) {
            load_secure_password(&app, &id)?
        } else {
            None
        };

    if previous_credential.is_some() {
        delete_secure_password(&app, &id)?;
    }
    store.remove_connection(&id);
    let delete_key = key_id.as_deref().is_some_and(|candidate_key_id| {
        should_delete_managed_key(&store, candidate_key_id, preserve_managed_key)
    });
    if let Err(save_error) = store.save(&app) {
        let rollback_error = restore_secure_password(&app, &id, previous_credential.as_ref()).err();
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("Failed to delete connection: {save_error}; credential rollback failed: {rollback_error}")
            }
            None => save_error,
        });
    }

    if delete_key {
        if let Some(key_id) = key_id {
            delete_managed_ssh_key_file(&app, &key_id)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assert_key_store_empty(keys_dir: &Path) {
        let files: Vec<_> = fs::read_dir(keys_dir)
            .expect("failed to list ssh-keys dir")
            .flatten()
            .map(|entry| entry.path())
            .collect();
        assert!(
            files.is_empty(),
            "rejected key must not create files: {files:?}"
        );
    }

    #[test]
    fn stored_credential_is_bound_to_connection_target() {
        let connection = SavedConnection {
            id: "connection-1".to_string(),
            name: "Production".to_string(),
            host: "Example.COM.".to_string(),
            port: 22,
            username: "deploy".to_string(),
            key_id: None,
            key_name: None,
            has_saved_password: true,
            use_keyboard_interactive: false,
            startup_script: None,
            startup_script_ready_text: None,
        };
        let credential = StoredCredential::new(&connection, "secret".to_string());

        assert!(credential.matches(&connection));

        let mut changed = connection.clone();
        changed.host = "attacker.example".to_string();
        assert!(!credential.matches(&changed));

        changed = connection.clone();
        changed.port = 2222;
        assert!(!credential.matches(&changed));

        changed = connection.clone();
        changed.username = "root".to_string();
        assert!(!credential.matches(&changed));

        let serialized =
            serde_json::to_string(&credential).expect("failed to serialize credential");
        let restored: StoredCredential =
            serde_json::from_str(&serialized).expect("failed to deserialize credential");
        assert_eq!(restored, credential);
    }

    #[test]
    fn managed_key_deletion_respects_saved_and_runtime_references() {
        let connection = SavedConnection {
            id: "connection-1".to_string(),
            name: "Production".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            key_id: Some("key-shared".to_string()),
            key_name: Some("id_ed25519".to_string()),
            has_saved_password: false,
            use_keyboard_interactive: false,
            startup_script: None,
            startup_script_ready_text: None,
        };
        let mut store = ConnectionsStore {
            connections: vec![connection],
        };

        assert!(!should_delete_managed_key(&store, "key-shared", false));
        store.connections.clear();
        assert!(should_delete_managed_key(&store, "key-shared", false));
        assert!(!should_delete_managed_key(&store, "key-shared", true));
    }

    #[test]
    fn connection_storage_enforces_field_count_and_total_budgets() {
        let connection = SavedConnection {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Production".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            key_id: None,
            key_name: None,
            has_saved_password: false,
            use_keyboard_interactive: false,
            startup_script: None,
            startup_script_ready_text: None,
        };
        assert!(validate_saved_connection(&connection, None).is_ok());

        let mut oversized = connection.clone();
        oversized.startup_script = Some("x".repeat(MAX_STARTUP_SCRIPT_BYTES + 1));
        assert!(validate_saved_connection(&oversized, None).is_err());
        assert!(validate_saved_connection(
            &connection,
            Some(&"x".repeat(MAX_SAVED_PASSWORD_BYTES + 1)),
        )
        .is_err());

        let mut store = ConnectionsStore::default();
        for _ in 0..=MAX_CONNECTIONS {
            let mut item = connection.clone();
            item.id = uuid::Uuid::new_v4().to_string();
            store.connections.push(item);
        }
        assert!(validate_connection_store(&store).is_err());
    }

    #[test]
    fn managed_key_ids_are_opaque_and_bound_to_the_connection_target() {
        let root =
            std::env::temp_dir().join(format!("redterm-managed-key-test-{}", uuid::Uuid::new_v4()));
        let keys_dir = root.join("ssh-keys");
        fs::create_dir_all(&keys_dir).expect("failed to create managed key test dir");
        let uploaded = store_uploaded_ssh_key(
            &keys_dir,
            "id_ed25519",
            b"private-key",
            "Example.COM.",
            22,
            "deploy",
        )
        .expect("failed to store managed key fixture");

        let resolved =
            resolve_managed_ssh_key_path(&keys_dir, &uploaded.key_id, "example.com", 22, "deploy")
                .expect("bound key should resolve");
        assert_eq!(
            resolved,
            fs::canonicalize(keys_dir.join(format!("{}.key", uploaded.key_id))).unwrap()
        );
        assert!(resolve_managed_ssh_key_path(
            &keys_dir,
            &uploaded.key_id,
            "attacker.example",
            22,
            "deploy",
        )
        .is_err());
        assert!(resolve_managed_ssh_key_path(
            &keys_dir,
            "../connections.json",
            "example.com",
            22,
            "deploy",
        )
        .is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let key_path = keys_dir.join(format!("{}.key", uploaded.key_id));
            fs::remove_file(&key_path).expect("failed to remove managed key fixture");
            let outside_file = root.join("outside");
            fs::write(&outside_file, b"outside").expect("failed to write outside fixture");
            symlink(&outside_file, &key_path).expect("failed to create key symlink fixture");
            assert!(resolve_managed_ssh_key_path(
                &keys_dir,
                &uploaded.key_id,
                "example.com",
                22,
                "deploy",
            )
            .is_err());
        }

        fs::remove_dir_all(root).expect("failed to remove managed key test dir");
    }

    #[test]
    fn saved_connection_discards_legacy_ciphertext() {
        let legacy_ciphertext_fixture = format!("legacy-{}", "ciphertext");
        let connection: SavedConnection = serde_json::from_value(serde_json::json!({
            "id": "legacy-connection",
            "name": "Legacy",
            "host": "example.com",
            "port": 22,
            "username": "deploy",
            "encrypted_password": legacy_ciphertext_fixture
        }))
        .expect("failed to deserialize legacy connection");

        assert!(!connection.has_saved_password);
        let serialized = serde_json::to_value(connection).expect("failed to serialize connection");
        assert!(serialized.get("encrypted_password").is_none());
    }

    #[test]
    fn upload_ssh_key_rejects_public_key_content_before_copying_and_accepts_private_headers() {
        let root =
            std::env::temp_dir().join(format!("redterm-upload-key-test-{}", uuid::Uuid::new_v4()));
        let keys_dir = root.join("ssh-keys");
        fs::create_dir_all(&keys_dir).expect("failed to create SSH key test dir");
        let oversized_key = vec![0_u8; MAX_SSH_KEY_BYTES + 1];
        assert_eq!(
            store_uploaded_ssh_key(
                &keys_dir,
                "oversized-key",
                &oversized_key,
                "example.com",
                22,
                "deploy",
            )
            .unwrap_err(),
            "SSH key file exceeds 1 MiB"
        );
        assert_key_store_empty(&keys_dir);

        let public_key_cases = [
            (
                "public-ed25519-redterm-test.pub",
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuardRegression test@example\n",
            ),
            (
                "public-rsa-redterm-test.pub",
                "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQGuardRegression test@example\n",
            ),
            (
                "public-ecdsa-redterm-test.pub",
                "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY= test@example\n",
            ),
            (
                "public-pem-redterm-test.pem",
                "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n",
            ),
            (
                "public-sk-ed25519-redterm-test.pub",
                "sk-ssh-ed25519@openssh.com AAAAC3NzaC1zaC1lZDI1NTE5AAAAIGuardRegression test@example\n",
            ),
            (
                "public-sk-ecdsa-redterm-test.pub",
                "sk-ecdsa-sha2-nistp256@openssh.com AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY= test@example\n",
            ),
            (
                "public-dss-redterm-test.pub",
                "ssh-dss AAAAB3NzaC1kc3MAAACBGuardRegression test@example\n",
            ),
            (
                "public-ed25519-cert-redterm-test.pub",
                "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29t test@example\n",
            ),
            (
                "public-rsa-pem-redterm-test.pem",
                "-----BEGIN RSA PUBLIC KEY-----\nMIIBCgKCAQEAredtermtest\n-----END RSA PUBLIC KEY-----\n",
            ),
            (
                "public-ec-pem-redterm-test.pem",
                "-----BEGIN EC PUBLIC KEY-----\nMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEredtermtest\n-----END EC PUBLIC KEY-----\n",
            ),
        ];

        for (file_name, content) in public_key_cases {
            let result = store_uploaded_ssh_key(
                &keys_dir,
                file_name,
                content.as_bytes(),
                "example.com",
                22,
                "deploy",
            );

            assert_eq!(
                result.unwrap_err(),
                "Please choose a private key file. Public keys cannot be used for SSH authentication."
            );
            assert_key_store_empty(&keys_dir);
        }

        let private_key_cases = [
            (
                "private-openssh-redterm-test",
                "-----BEGIN OPENSSH PRIVATE KEY-----\nredterm-test\n-----END OPENSSH PRIVATE KEY-----\n", // gitleaks:allow
            ),
            (
                "private-rsa-redterm-test",
                "-----BEGIN RSA PRIVATE KEY-----\nredterm-test\n-----END RSA PRIVATE KEY-----\n", // gitleaks:allow
            ),
            (
                "private-ec-redterm-test",
                "-----BEGIN EC PRIVATE KEY-----\nredterm-test\n-----END EC PRIVATE KEY-----\n", // gitleaks:allow
            ),
            (
                "private-pkcs8-redterm-test.pem",
                "-----BEGIN PRIVATE KEY-----\nredterm-test\n-----END PRIVATE KEY-----\n", // gitleaks:allow
            ),
            (
                "private-encrypted-pkcs8-redterm-test.pem",
                "-----BEGIN ENCRYPTED PRIVATE KEY-----\nredterm-test\n-----END ENCRYPTED PRIVATE KEY-----\n", // gitleaks:allow
            ),
        ];

        for (file_name, content) in private_key_cases {
            let result = store_uploaded_ssh_key(
                &keys_dir,
                file_name,
                content.as_bytes(),
                "example.com",
                22,
                "deploy",
            )
            .expect("private key headers should be accepted for upload");

            assert_eq!(result.file_name, sanitize_file_name(file_name));
            let key_path = keys_dir.join(format!("{}.key", result.key_id));
            let metadata_path = keys_dir.join(format!("{}.json", result.key_id));
            let stored = fs::read(&key_path).expect("uploaded key should be copied");
            assert_eq!(stored, content.as_bytes());
            let metadata: ManagedSshKeyMetadata = serde_json::from_slice(
                &fs::read(&metadata_path).expect("managed key metadata should exist"),
            )
            .expect("managed key metadata should deserialize");
            assert!(metadata.matches_target("EXAMPLE.COM.", 22, "deploy"));

            #[cfg(unix)]
            {
                let permissions = fs::metadata(&key_path)
                    .expect("uploaded key metadata should be readable")
                    .permissions();
                assert_eq!(permissions.mode() & 0o777, 0o600);
            }

            fs::remove_file(key_path).expect("failed to remove uploaded key fixture");
            fs::remove_file(metadata_path).expect("failed to remove uploaded key metadata");
        }

        fs::remove_dir_all(root).expect("failed to remove SSH key test dir");
    }
    #[test]
    fn managed_key_storage_enforces_aggregate_file_limit() {
        let root =
            std::env::temp_dir().join(format!("redterm-key-quota-test-{}", uuid::Uuid::new_v4()));
        let keys_dir = root.join("ssh-keys");
        fs::create_dir_all(&keys_dir).expect("failed to create SSH key quota dir");

        for index in 0..MAX_MANAGED_SSH_KEYS {
            store_uploaded_ssh_key(
                &keys_dir,
                &format!("key-{index}"),
                b"private-key",
                "example.com",
                22,
                "deploy",
            )
            .expect("key within aggregate quota should be stored");
        }
        assert_eq!(
            store_uploaded_ssh_key(
                &keys_dir,
                "key-over-limit",
                b"private-key",
                "example.com",
                22,
                "deploy",
            )
            .unwrap_err(),
            "Managed SSH key storage limit reached"
        );

        fs::remove_dir_all(root).expect("failed to remove SSH key quota dir");
    }
}

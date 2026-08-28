use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default)]
    pub has_saved_password: bool,
    #[serde(default)]
    pub use_keyboard_interactive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_script_ready_text: Option<String>,
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
    pub key_path: String,
    pub file_name: String,
}

const PUBLIC_KEY_UPLOAD_ERROR: &str =
    "Please choose a private key file. Public keys cannot be used for SSH authentication.";

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

#[cfg(not(target_os = "android"))]
const CREDENTIAL_SERVICE: &str = "com.coderred.redterm.saved-connections";

#[cfg(target_os = "android")]
fn store_secure_value(app: &AppHandle, connection_id: &str, value: &str) -> Result<(), String> {
    tauri_plugin_redterm_android_paste::store_credential(
        app,
        connection_id.to_string(),
        value.to_string(),
    )
}

#[cfg(not(target_os = "android"))]
fn store_secure_value(_app: &AppHandle, connection_id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, connection_id)
        .and_then(|entry| entry.set_password(value))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn load_secure_value(app: &AppHandle, connection_id: &str) -> Result<Option<String>, String> {
    tauri_plugin_redterm_android_paste::get_credential(app, connection_id.to_string())
}

#[cfg(not(target_os = "android"))]
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

#[cfg(not(target_os = "android"))]
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
            let json = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            serde_json::from_str(&json).map_err(|error| error.to_string())?
        } else {
            Self::default()
        };

        Ok(store)
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = Self::get_config_path(app);
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;

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

fn resolve_managed_ssh_key_path(keys_dir: &Path, key_path: &str) -> Result<PathBuf, String> {
    let canonical_keys_dir = fs::canonicalize(keys_dir).map_err(|e| e.to_string())?;
    let candidate = PathBuf::from(key_path);
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "Invalid managed SSH key path".to_string())?;
    let expected_path = canonical_keys_dir.join(file_name);

    if candidate != expected_path {
        return Err("SSH key path is outside the managed key directory".to_string());
    }

    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(expected_path),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("Managed SSH key path cannot be a symbolic link".to_string());
    }

    let canonical_candidate = fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if canonical_candidate.parent() != Some(canonical_keys_dir.as_path()) {
        return Err("SSH key path is outside the managed key directory".to_string());
    }

    Ok(canonical_candidate)
}

fn delete_managed_ssh_key_file(app: &AppHandle, key_path: &str) -> Result<(), String> {
    let keys_dir = get_ssh_keys_dir(app)?;
    let safe_path = resolve_managed_ssh_key_path(&keys_dir, key_path)?;

    match fs::remove_file(safe_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn store_uploaded_ssh_key(
    keys_dir: &Path,
    file_name: &str,
    data: &[u8],
) -> Result<UploadedSshKeyResult, String> {
    if data.is_empty() {
        return Err("SSH key file is empty".to_string());
    }
    if is_public_ssh_key_content(data) {
        return Err(PUBLIC_KEY_UPLOAD_ERROR.to_string());
    }

    let safe_name = sanitize_file_name(file_name);
    let file_path = keys_dir.join(format!("{}-{}", uuid::Uuid::new_v4(), safe_name));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = options.open(&file_path).map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(data) {
        drop(file);
        let _ = fs::remove_file(&file_path);
        return Err(error.to_string());
    }

    Ok(UploadedSshKeyResult {
        key_path: file_path.to_string_lossy().into_owned(),
        file_name: safe_name,
    })
}

#[tauri::command]
pub fn upload_ssh_key(
    app: AppHandle,
    file_name: String,
    data: Vec<u8>,
) -> Result<UploadedSshKeyResult, String> {
    let keys_dir = get_ssh_keys_dir(&app)?;
    store_uploaded_ssh_key(&keys_dir, &file_name, &data)
}

#[tauri::command]
pub fn delete_uploaded_ssh_key(app: AppHandle, key_path: String) -> Result<(), String> {
    delete_managed_ssh_key_file(&app, &key_path)
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
    let connection_id = connection.id.clone();
    let mut store = ConnectionsStore::load(&app)?;
    let existing_connection = store
        .connections
        .iter()
        .find(|stored| stored.id == connection_id);
    let existing_key_path = existing_connection.and_then(|stored| stored.key_path.clone());
    let previous_credential = if existing_connection.is_some_and(|stored| stored.has_saved_password)
    {
        load_secure_password(&app, &connection_id)?
    } else {
        None
    };

    match password {
        Some(password) if !password.is_empty() => {
            let credential = StoredCredential::new(&connection, password);
            store_secure_password(&app, &connection_id, &credential)?;
            connection.has_saved_password = true;
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

    store.add_connection(connection);
    if let Err(save_error) = store.save(&app) {
        let rollback_error =
            restore_secure_password(&app, &connection_id, previous_credential.as_ref()).err();
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("Failed to save connection: {save_error}; credential rollback failed: {rollback_error}")
            }
            None => save_error,
        });
    }

    if let Some(old_key_path) = existing_key_path {
        let new_key_path = store
            .connections
            .iter()
            .find(|conn| conn.id == connection_id)
            .and_then(|conn| conn.key_path.as_deref());

        if new_key_path != Some(old_key_path.as_str()) {
            delete_managed_ssh_key_file(&app, &old_key_path)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_decrypted_password(
    app: AppHandle,
    connection_id: String,
) -> Result<Option<String>, String> {
    let store = ConnectionsStore::load(&app)?;
    let Some(connection) = store
        .connections
        .iter()
        .find(|stored| stored.id == connection_id)
    else {
        return Ok(None);
    };
    if !connection.has_saved_password {
        return Ok(None);
    }

    let credential = load_secure_password(&app, &connection_id)?.ok_or_else(|| {
        "Saved password is unavailable in the platform credential store".to_string()
    })?;
    if !credential.matches(connection) {
        return Err(
            "Saved credential does not match this host, port, and username. Please re-enter the password."
                .to_string(),
        );
    }
    Ok(Some(credential.password))
}

#[tauri::command]
pub fn delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = ConnectionsStore::load(&app)?;
    let existing_connection = store
        .connections
        .iter()
        .find(|connection| connection.id == id);
    let key_path = existing_connection.and_then(|connection| connection.key_path.clone());
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
    if let Err(save_error) = store.save(&app) {
        let rollback_error = restore_secure_password(&app, &id, previous_credential.as_ref()).err();
        return Err(match rollback_error {
            Some(rollback_error) => {
                format!("Failed to delete connection: {save_error}; credential rollback failed: {rollback_error}")
            }
            None => save_error,
        });
    }

    if let Some(key_path) = key_path {
        delete_managed_ssh_key_file(&app, &key_path)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assert_no_uploaded_key_with_name(keys_dir: &Path, safe_name: &str) {
        let copied_files: Vec<_> = fs::read_dir(keys_dir)
            .expect("failed to list ssh-keys dir")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(safe_name))
            .map(|entry| entry.path())
            .collect();

        assert!(
            copied_files.is_empty(),
            "public key content must be rejected before copying into ssh-keys; found {copied_files:?}"
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
            key_path: None,
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
    fn managed_key_path_rejects_traversal_nested_paths_and_symlinks() {
        let root =
            std::env::temp_dir().join(format!("redterm-managed-key-test-{}", uuid::Uuid::new_v4()));
        let keys_dir = root.join("ssh-keys");
        fs::create_dir_all(&keys_dir).expect("failed to create managed key test dir");
        let canonical_keys_dir =
            fs::canonicalize(&keys_dir).expect("failed to canonicalize managed key test dir");

        let valid_key = canonical_keys_dir.join("valid-key");
        fs::write(&valid_key, b"private-key").expect("failed to write managed key fixture");
        assert_eq!(
            resolve_managed_ssh_key_path(&canonical_keys_dir, valid_key.to_str().unwrap()).unwrap(),
            valid_key
        );

        let traversal = canonical_keys_dir.join("../connections.json");
        assert!(
            resolve_managed_ssh_key_path(&canonical_keys_dir, traversal.to_str().unwrap()).is_err()
        );

        let nested_dir = canonical_keys_dir.join("nested");
        fs::create_dir_all(&nested_dir).expect("failed to create nested key dir");
        let nested_key = nested_dir.join("key");
        fs::write(&nested_key, b"private-key").expect("failed to write nested key fixture");
        assert!(
            resolve_managed_ssh_key_path(&canonical_keys_dir, nested_key.to_str().unwrap())
                .is_err()
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let outside_file = root.join("outside");
            fs::write(&outside_file, b"outside").expect("failed to write outside fixture");
            let key_symlink = canonical_keys_dir.join("key-link");
            symlink(&outside_file, &key_symlink).expect("failed to create key symlink fixture");
            assert!(resolve_managed_ssh_key_path(
                &canonical_keys_dir,
                key_symlink.to_str().unwrap()
            )
            .is_err());
        }

        fs::remove_dir_all(root).expect("failed to remove managed key test dir");
    }

    #[test]
    fn saved_connection_discards_legacy_ciphertext() {
        let connection: SavedConnection = serde_json::from_value(serde_json::json!({
            "id": "legacy-connection",
            "name": "Legacy",
            "host": "example.com",
            "port": 22,
            "username": "deploy",
            "encrypted_password": "legacy-ciphertext"
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
            let safe_name = sanitize_file_name(file_name);
            let result = store_uploaded_ssh_key(&keys_dir, file_name, content.as_bytes());

            match result {
                Ok(uploaded) => {
                    let _ = fs::remove_file(&uploaded.key_path);
                    panic!(
                        "expected public key content in {file_name} to be rejected before upload, but it was stored at {}",
                        uploaded.key_path
                    );
                }
                Err(message) => {
                    assert_eq!(
                        message,
                        "Please choose a private key file. Public keys cannot be used for SSH authentication."
                    );
                }
            }

            assert_no_uploaded_key_with_name(&keys_dir, &safe_name);
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
            let result = store_uploaded_ssh_key(&keys_dir, file_name, content.as_bytes())
                .expect("private key headers should be accepted for upload");

            assert_eq!(result.file_name, sanitize_file_name(file_name));
            let stored = fs::read(&result.key_path).expect("uploaded key should be copied");
            assert_eq!(stored, content.as_bytes());

            #[cfg(unix)]
            {
                let permissions = fs::metadata(&result.key_path)
                    .expect("uploaded key metadata should be readable")
                    .permissions();
                assert_eq!(permissions.mode() & 0o777, 0o600);
            }

            fs::remove_file(&result.key_path).expect("failed to remove uploaded key fixture");
        }

        fs::remove_dir_all(root).expect("failed to remove SSH key test dir");
    }
}

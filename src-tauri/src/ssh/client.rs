use russh::client::{self, Config, Handle, Msg};
use russh::keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use super::known_hosts::{classify_public_key, HostKeyClassification};
use super::{AuthConfig, AuthMethod};

const SSH_DATA_CHUNK_BYTES: usize = 64 * 1024;
const SSH_COMMAND_CHANNEL_CAPACITY: usize = 256;
const MAX_EXEC_CAPTURE_BYTES: usize = 64 * 1024;
const MAX_SFTP_LIST_ENTRIES: usize = 10_000;
const EXEC_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
const SSH_COMMAND_ENQUEUE_TIMEOUT: Duration = Duration::from_secs(5);
const SSH_CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Error, Debug)]
pub enum SshError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),
    #[error("Session error: {0}")]
    SessionError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Key error: {0}")]
    KeyError(String),
    #[error("Channel closed")]
    ChannelClosed,
}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::SessionError(e.to_string())
    }
}

impl From<SshError> for String {
    fn from(e: SshError) -> Self {
        e.to_string()
    }
}

fn load_secret_key_normalized<P: AsRef<Path>>(
    key_path: P,
    passphrase: Option<&str>,
) -> Result<PrivateKey, russh::keys::Error> {
    if passphrase.is_none() {
        let contents = std::fs::read_to_string(key_path.as_ref())?;
        if contents
            .lines()
            .find(|line| !line.trim().is_empty())
            .is_some_and(|line| line.trim() == "-----BEGIN ENCRYPTED PRIVATE KEY-----")
        {
            return Err(russh::keys::Error::KeyIsEncrypted);
        }
    }

    load_secret_key(key_path, passphrase)
}

pub struct ClientHandler {
    host: String,
    port: u16,
    known_hosts_path: std::path::PathBuf,
}

impl client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let server_public_key = server_key.public_key();
        match classify_public_key(
            &self.host,
            self.port,
            &server_public_key,
            Path::new(&self.known_hosts_path),
        ) {
            Ok(HostKeyClassification::Trusted) => Ok(true),
            Ok(HostKeyClassification::Unknown { fingerprint }) => {
                log::warn!(
                    "unknown SSH host key for {}:{} ({})",
                    self.host,
                    self.port,
                    fingerprint
                );
                Ok(false)
            }
            Ok(HostKeyClassification::Changed { fingerprint }) => {
                log::warn!(
                    "changed SSH host key for {}:{} ({})",
                    self.host,
                    self.port,
                    fingerprint
                );
                Ok(false)
            }
            Err(e) => Err(SshError::ConnectionFailed(format!(
                "Host key verification failed for {}:{} ({})",
                self.host, self.port, e
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SftpDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
}

pub struct SshConnection {
    handle: Handle<ClientHandler>,
}

impl SshConnection {
    pub async fn connect(
        host: &str,
        port: u16,
        auth: AuthConfig,
        known_hosts_path: std::path::PathBuf,
    ) -> Result<Self, SshError> {
        let config = Arc::new(Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            inactivity_timeout: Some(Duration::from_secs(30)),
            // Allow up to ~30 minutes of missed keepalive replies before dropping.
            keepalive_max: 120,
            ..Config::default()
        });

        let handler = ClientHandler {
            host: host.to_string(),
            port,
            known_hosts_path,
        };

        let mut handle = client::connect(config, (host, port), handler)
            .await
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;

        // Authenticate
        let authenticated = match &auth.method {
            AuthMethod::Password { password } => handle
                .authenticate_password(&auth.username, password)
                .await
                .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?,
            AuthMethod::StoredPassword { .. } => {
                return Err(SshError::AuthenticationFailed(
                    "Stored credentials must be resolved before SSH authentication".to_string(),
                ));
            }
            AuthMethod::ResolvedKey {
                key_path,
                passphrase,
            } => {
                let key = load_secret_key_normalized(key_path, passphrase.as_deref())
                    .map_err(|e| SshError::KeyError(e.to_string()))?;
                let hash_alg = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?
                    .flatten();
                let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);

                handle
                    .authenticate_publickey(&auth.username, key)
                    .await
                    .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?
            }
            AuthMethod::Key { .. } => {
                return Err(SshError::AuthenticationFailed(
                    "Managed SSH keys must be resolved before authentication".to_string(),
                ));
            }
        };

        if !authenticated.success() {
            return Err(SshError::AuthenticationFailed(
                "Authentication rejected".to_string(),
            ));
        }

        Ok(Self { handle })
    }

    pub async fn open_shell(
        &mut self,
        cols: u32,
        rows: u32,
        data_tx: mpsc::Sender<Vec<u8>>,
        exit_tx: Option<oneshot::Sender<()>>,
    ) -> Result<SshSession, SshError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        // Request PTY (wait for reply)
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        // Request shell (wait for reply)
        channel
            .request_shell(true)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        Ok(SshSession::new(channel, data_tx, exit_tx))
    }

    async fn exec_capture(&self, command: &str) -> Result<(Option<u32>, String, String), SshError> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        channel
            .exec(true, command)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status = None;

        let deadline = tokio::time::Instant::now() + EXEC_CAPTURE_TIMEOUT;
        loop {
            let message = tokio::time::timeout_at(deadline, channel.wait())
                .await
                .map_err(|_| SshError::SessionError("Remote command timed out".to_string()))?;
            match message {
                Some(ChannelMsg::Data { data }) => {
                    if stdout.len() + stderr.len() + data.len() > MAX_EXEC_CAPTURE_BYTES {
                        return Err(SshError::SessionError(
                            "Remote command output exceeded 64 KiB".to_string(),
                        ));
                    }
                    stdout.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if stdout.len() + stderr.len() + data.len() > MAX_EXEC_CAPTURE_BYTES {
                        return Err(SshError::SessionError(
                            "Remote command output exceeded 64 KiB".to_string(),
                        ));
                    }
                    stderr.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExitStatus { exit_status: code }) => {
                    exit_status = Some(code);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }

        let out = String::from_utf8_lossy(&stdout).trim().to_string();
        let err = String::from_utf8_lossy(&stderr).trim().to_string();

        Ok((exit_status, out, err))
    }

    pub async fn detect_remote_os(&self) -> Result<String, SshError> {
        if let Ok((_, stdout, _)) = self.exec_capture("uname -s").await {
            let uname = stdout.to_lowercase();
            if uname.contains("linux") {
                return Ok("linux".to_string());
            }
            if uname.contains("darwin") {
                return Ok("macos".to_string());
            }
        }

        if let Ok((_, stdout, stderr)) = self.exec_capture("cmd /c ver").await {
            let text = format!("{} {}", stdout, stderr).to_lowercase();
            if text.contains("windows") {
                return Ok("windows".to_string());
            }
        }

        Ok("unknown".to_string())
    }

    async fn open_sftp(&self) -> Result<SftpSession, SshError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))
    }

    pub async fn upload_file_via_sftp(
        &self,
        extension: &str,
        data: &[u8],
    ) -> Result<String, SshError> {
        let sftp = self.open_sftp().await?;
        let remote_path = format!("/tmp/redterm-{}.{}", uuid::Uuid::new_v4(), extension);
        let file_permissions = FileAttributes {
            permissions: Some(0o600),
            ..FileAttributes::default()
        };
        let mut file = match sftp
            .open_with_flags_and_attributes(
                &remote_path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                file_permissions,
            )
            .await
        {
            Ok(file) => file,
            Err(error) => return Err(SshError::SessionError(error.to_string())),
        };

        if let Err(error) = file.write_all(data).await {
            drop(file);
            let _ = sftp.remove_file(&remote_path).await;
            return Err(SshError::SessionError(error.to_string()));
        }
        if let Err(error) = file.shutdown().await {
            drop(file);
            let _ = sftp.remove_file(&remote_path).await;
            return Err(SshError::SessionError(error.to_string()));
        }

        Ok(remote_path)
    }

    pub async fn list_dir_via_sftp(&self, path: &str) -> Result<Vec<SftpDirEntry>, SshError> {
        let sftp = self.open_sftp().await?;
        let mut entries = Vec::new();
        for entry in sftp
            .read_dir(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?
        {
            if entries.len() >= MAX_SFTP_LIST_ENTRIES {
                break;
            }
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let metadata = entry.metadata();
            entries.push(SftpDirEntry {
                is_dir: entry.file_type().is_dir(),
                name,
                size: metadata.size.unwrap_or(0),
                mtime: metadata.mtime.map(|value| value as i64).unwrap_or(0),
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn read_file_via_sftp(
        &self,
        path: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, SshError> {
        let sftp = self.open_sftp().await?;
        if let Some(size) = sftp
            .metadata(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?
            .size
        {
            if size > max_bytes {
                return Err(SshError::SessionError(format!(
                    "File is too large to preview ({} bytes exceeds the {} byte limit)",
                    size, max_bytes
                )));
            }
        }

        // Stream instead of read_to_end: the advertised size may be absent
        // or stale (e.g. /dev/zero), so the cap is enforced while reading.
        let mut remote_file = sftp
            .open(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        let mut data = Vec::new();
        let mut buffer = vec![0_u8; 256 * 1024];
        loop {
            let read = remote_file
                .read(&mut buffer)
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
            if read == 0 {
                break;
            }
            if data.len() as u64 + read as u64 > max_bytes {
                return Err(SshError::SessionError(format!(
                    "File exceeded the {} byte preview limit while reading",
                    max_bytes
                )));
            }
            data.extend_from_slice(&buffer[..read]);
        }
        Ok(data)
    }

    pub async fn download_file_via_sftp(
        &self,
        remote_path: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<u64, SshError> {
        let sftp = self.open_sftp().await?;
        if let Some(size) = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?
            .size
        {
            if size > max_bytes {
                return Err(SshError::SessionError(format!(
                    "File is too large to preview ({} bytes exceeds the {} byte limit)",
                    size, max_bytes
                )));
            }
        }

        let mut remote_file = sftp
            .open(remote_path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        let mut local_file = tokio::fs::File::create(destination)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        let mut buffer = vec![0_u8; 256 * 1024];
        let mut total: u64 = 0;
        loop {
            let read = remote_file
                .read(&mut buffer)
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > max_bytes {
                return Err(SshError::SessionError(format!(
                    "Download exceeded the {} byte preview limit",
                    max_bytes
                )));
            }
            local_file
                .write_all(&buffer[..read])
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
        }
        local_file
            .flush()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        Ok(total)
    }
}

enum ChannelCommand {
    Write(Vec<u8>),
    Resize(u32, u32),
}

#[derive(Clone)]
pub struct SshSessionHandle {
    cmd_tx: mpsc::Sender<ChannelCommand>,
}

impl SshSessionHandle {
    pub async fn write(&self, data: &[u8]) -> Result<(), SshError> {
        tokio::time::timeout(
            SSH_COMMAND_ENQUEUE_TIMEOUT,
            self.cmd_tx.send(ChannelCommand::Write(data.to_vec())),
        )
        .await
        .map_err(|_| SshError::SessionError("SSH write queue timed out".to_string()))?
        .map_err(|_| SshError::ChannelClosed)
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        tokio::time::timeout(
            SSH_COMMAND_ENQUEUE_TIMEOUT,
            self.cmd_tx.send(ChannelCommand::Resize(cols, rows)),
        )
        .await
        .map_err(|_| SshError::SessionError("SSH resize queue timed out".to_string()))?
        .map_err(|_| SshError::ChannelClosed)
    }
}

pub struct SshSession {
    handle: SshSessionHandle,
    close_tx: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl SshSession {
    pub fn new(
        mut channel: russh::Channel<Msg>,
        data_tx: mpsc::Sender<Vec<u8>>,
        exit_tx: Option<oneshot::Sender<()>>,
    ) -> Self {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<ChannelCommand>(SSH_COMMAND_CHANNEL_CAPACITY);
        let (close_tx, mut close_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut exit_tx = exit_tx;
            'channel_loop: loop {
                tokio::select! {
                    biased;
                    _ = close_rx.changed() => {
                        log::info!("[SSH] close signal received");
                        break;
                    }
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(ChannelCommand::Write(data)) => {
                                tokio::select! {
                                    biased;
                                    _ = close_rx.changed() => break 'channel_loop,
                                    result = channel.data_bytes(data) => {
                                        if let Err(error) = result {
                                            log::error!("[SSH] channel.data failed: {:?}", error);
                                            break 'channel_loop;
                                        }
                                    }
                                }
                            }
                            Some(ChannelCommand::Resize(cols, rows)) => {
                                tokio::select! {
                                    biased;
                                    _ = close_rx.changed() => break 'channel_loop,
                                    _ = channel.window_change(cols, rows, 0, 0) => {}
                                }
                            }
                            None => break,
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                for chunk in data.chunks(SSH_DATA_CHUNK_BYTES) {
                                    let send_result = tokio::select! {
                                        biased;
                                        _ = close_rx.changed() => break 'channel_loop,
                                        result = data_tx.send(chunk.to_vec()) => result,
                                    };
                                    if send_result.is_err() {
                                        log::error!("[SSH] data_tx.send failed");
                                        break 'channel_loop;
                                    }
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                for chunk in data.chunks(SSH_DATA_CHUNK_BYTES) {
                                    let send_result = tokio::select! {
                                        biased;
                                        _ = close_rx.changed() => break 'channel_loop,
                                        result = data_tx.send(chunk.to_vec()) => result,
                                    };
                                    if send_result.is_err() {
                                        log::error!("[SSH] data_tx.send (extended) failed");
                                        break 'channel_loop;
                                    }
                                }
                            }
                            Some(ChannelMsg::Eof) => {
                                log::info!("[SSH] received EOF from server");
                                break;
                            }
                            Some(ChannelMsg::Close) => {
                                log::info!("[SSH] received Close from server");
                                break;
                            }
                            Some(ChannelMsg::Success) => {
                                log::info!("[SSH] received Success");
                            }
                            Some(ChannelMsg::Failure) => {
                                log::error!("[SSH] received Failure from server");
                                break;
                            }
                            Some(other) => {
                                log::info!("[SSH] received other message: {:?}", other);
                            }
                            None => {
                                log::info!("[SSH] channel.wait() returned None");
                                break;
                            }
                        }
                    }
                }
            }
            let _ = tokio::time::timeout(Duration::from_secs(1), channel.eof()).await;
            log::info!("[SSH] task loop exited");
            if let Some(exit_tx) = exit_tx.take() {
                let _ = exit_tx.send(());
            }
        });

        Self {
            handle: SshSessionHandle { cmd_tx },
            close_tx,
            task: Some(task),
        }
    }

    pub fn command_handle(&self) -> SshSessionHandle {
        self.handle.clone()
    }

    pub async fn close(mut self) -> Result<(), SshError> {
        let _ = self.close_tx.send(true);
        if let Some(mut task) = self.task.take() {
            if tokio::time::timeout(SSH_CHANNEL_CLOSE_TIMEOUT, &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PKCS8_ENCRYPTED: &str = "-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFLTBXBgkqhkiG9w0BBQ0wSjApBgkqhkiG9w0BBQwwHAQITo1O0b8YrS0CAggA
MAwGCCqGSIb3DQIJBQAwHQYJYIZIAWUDBAEqBBBtLH4T1KOfo1GGr7salhR8BIIE
0KN9ednYwcTGSX3hg7fROhTw7JAJ1D4IdT1fsoGeNu2BFuIgF3cthGHe6S5zceI2
MpkfwvHbsOlDFWMUIAb/VY8/iYxhNmd5J6NStMYRC9NC0fVzOmrJqE1wITqxtORx
IkzqkgFUbaaiFFQPepsh5CvQfAgGEWV329SsTOKIgyTj97RxfZIKA+TR5J5g2dJY
j346SvHhSxJ4Jc0asccgMb0HGh9UUDzDSql0OIdbnZW5KzYJPOx+aDqnpbz7UzY/
P8N0w/pEiGmkdkNyvGsdttcjFpOWlLnLDhtLx8dDwi/sbEYHtpMzsYC9jPn3hnds
TcotqjoSZ31O6rJD4z18FOQb4iZs3MohwEdDd9XKblTfYKM62aQJWH6cVQcg+1C7
jX9l2wmyK26Tkkl5Qg/qSfzrCveke5muZgZkFwL0GCcgPJ8RixSB4GOdSMa/hAMU
kvFAtoV2GluIgmSe1pG5cNMhurxM1dPPf4WnD+9hkFFSsMkTAuxDZIdDk3FA8zof
Yhv0ZTfvT6V+vgH3Hv7Tqcxomy5Qr3tj5vvAqqDU6k7fC4FvkxDh2mG5ovWvc4Nb
Xv8sed0LGpYitIOMldu6650LoZAqJVv5N4cAA2Edqldf7S2Iz1QnA/usXkQd4tLa
Z80+sDNv9eCVkfaJ6kOVLk/ghLdXWJYRLenfQZtVUXrPkaPpNXgD0dlaTN8KuvML
Uw/UGa+4ybnPsdVflI0YkJKbxouhp4iB4S5ACAwqHVmsH5GRnujf10qLoS7RjDAl
o/wSHxdT9BECp7TT8ID65u2mlJvH13iJbktPczGXt07nBiBse6OxsClfBtHkRLzE
QF6UMEXsJnIIMRfrZQnduC8FUOkfPOSXc8r9SeZ3GhfbV/DmWZvFPCpjzKYPsM5+
N8Bw/iZ7NIH4xzNOgwdp5BzjH9hRtCt4sUKVVlWfEDtTnkHNOusQGKu7HkBF87YZ
RN/Nd3gvHob668JOcGchcOzcsqsgzhGMD8+G9T9oZkFCYtwUXQU2XjMN0R4VtQgZ
rAxWyQau9xXMGyDC67gQ5xSn+oqMK0HmoW8jh2LG/cUowHFAkUxdzGadnjGhMOI2
zwNJPIjF93eDF/+zW5E1l0iGdiYyHkJbWSvcCuvTwma9FIDB45vOh5mSR+YjjSM5
nq3THSWNi7Cxqz12Q1+i9pz92T2myYKBBtu1WDh+2KOn5DUkfEadY5SsIu/Rb7ub
5FBihk2RN3y/iZk+36I69HgGg1OElYjps3D+A9AjVby10zxxLAz8U28YqJZm4wA/
T0HLxBiVw+rsHmLP79KvsT2+b4Diqih+VTXouPWC/W+lELYKSlqnJCat77IxgM9e
YIhzD47OgWl33GJ/R10+RDoDvY4koYE+V5NLglEhbwjloo9Ryv5ywBJNS7mfXMsK
/uf+l2AscZTZ1mhtL38efTQCIRjyFHc3V31DI0UdETADi+/Omz+bXu0D5VvX+7c6
b1iVZKpJw8KUjzeUV8yOZhvGu3LrQbhkTPVYL555iP1KN0Eya88ra+FUKMwLgjYr
JkUx4iad4dTsGPodwEP/Y9oX/Qk3ZQr+REZ8lg6IBoKKqqrQeBJ9gkm1jfKE6Xkc
Cog3JMeTrb3LiPHgN6gU2P30MRp6L1j1J/MtlOAr5rux
-----END ENCRYPTED PRIVATE KEY-----";

    const MALFORMED_UNENCRYPTED_PKCS8: &str = "-----BEGIN PRIVATE KEY-----
MIIBnotavalidderpayload
-----END PRIVATE KEY-----";

    static NEXT_KEY_FIXTURE_ID: AtomicUsize = AtomicUsize::new(0);

    struct KeyFixture {
        root: PathBuf,
        path: PathBuf,
    }

    impl KeyFixture {
        fn new(test_name: &str, contents: &str) -> Self {
            let id = NEXT_KEY_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "redterm-key-loader-test-{}-{}-{}",
                std::process::id(),
                id,
                test_name
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            let path = root.join("id_test");
            fs::write(&path, contents).unwrap();
            Self { root, path }
        }
    }

    impl Drop for KeyFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn load_key_error(fixture: &KeyFixture) -> String {
        match super::load_secret_key_normalized(&fixture.path, None::<&str>) {
            Ok(_) => panic!("fixture key unexpectedly loaded"),
            Err(error) => error.to_string(),
        }
    }

    #[test]
    fn encrypted_pkcs8_without_passphrase_reports_encrypted_key() {
        let fixture = KeyFixture::new("encrypted-pkcs8-no-passphrase", PKCS8_ENCRYPTED);

        let error = load_key_error(&fixture);

        assert!(
            error.contains("The key is encrypted"),
            "encrypted PKCS#8 without a passphrase should use the retryable encrypted-key message, got: {error}"
        );
        assert!(
            !error.contains("unexpected ASN.1 DER tag"),
            "encrypted PKCS#8 without a passphrase must not leak russh_keys DER parse text, got: {error}"
        );
    }

    #[test]
    fn malformed_unencrypted_pkcs8_does_not_report_encrypted_key() {
        let fixture = KeyFixture::new("malformed-unencrypted-pkcs8", MALFORMED_UNENCRYPTED_PKCS8);

        let error = load_key_error(&fixture);

        assert!(
            !error.contains("The key is encrypted"),
            "non-encrypted malformed PKCS#8 must not trigger passphrase retry UI, got: {error}"
        );
    }
}

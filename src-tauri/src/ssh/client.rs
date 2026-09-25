use russh::client::{self, Config, Handle, Msg};
use russh::keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::{mpsc, oneshot, watch};

use super::known_hosts::{classify_public_key, HostKeyClassification};
use super::{AuthConfig, AuthMethod};

const SSH_DATA_CHUNK_BYTES: usize = 64 * 1024;
const SSH_COMMAND_CHANNEL_CAPACITY: usize = 256;
const MAX_EXEC_CAPTURE_BYTES: usize = 64 * 1024;
const MAX_SFTP_LIST_ENTRIES: usize = 10_000;
const MAX_SFTP_LIST_NAME_BYTES: usize = 8 * 1024 * 1024;
const EXEC_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
const SSH_COMMAND_ENQUEUE_TIMEOUT: Duration = Duration::from_secs(5);
const SSH_CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

const MAX_SFTP_RESPONSE_BYTES: usize = 1024 * 1024;

// russh-sftp 2.4.0 passes u32::MAX to its client frame reader and allocates
// the advertised length. Guard each incoming frame before the library sees its
// header; pass payloads through the caller's ReadBuf without a second copy.
pub(super) struct BoundedSftpStream<S> {
    inner: S,
    header: [u8; 4],
    header_read: usize,
    header_sent: usize,
    remaining: usize,
    rejected: bool,
}

impl<S> BoundedSftpStream<S> {
    pub(super) fn new(inner: S) -> Self {
        Self {
            inner,
            header: [0; 4],
            header_read: 0,
            header_sent: 0,
            remaining: 0,
            rejected: false,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for BoundedSftpStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        if this.rejected {
            return Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()));
        }
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if this.header_sent == 4 && this.remaining == 0 {
            this.header_read = 0;
            this.header_sent = 0;
        }
        while this.header_read < 4 {
            let mut header_buf = ReadBuf::new(&mut this.header[this.header_read..]);
            match Pin::new(&mut this.inner).poll_read(cx, &mut header_buf) {
                Poll::Ready(Ok(())) if header_buf.filled().is_empty() => {
                    this.rejected = true;
                    return Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()));
                }
                Poll::Ready(Ok(())) => this.header_read += header_buf.filled().len(),
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            }
        }
        if this.header_sent == 0 {
            this.remaining = u32::from_be_bytes(this.header) as usize;
            if this.remaining > MAX_SFTP_RESPONSE_BYTES {
                this.rejected = true;
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "SFTP response exceeds 1 MiB",
                )));
            }
        }
        if this.header_sent < 4 {
            let count = buf.remaining().min(4 - this.header_sent);
            buf.put_slice(&this.header[this.header_sent..this.header_sent + count]);
            this.header_sent += count;
            return Poll::Ready(Ok(()));
        }
        let mut limited = buf.take(buf.remaining().min(this.remaining));
        match Pin::new(&mut this.inner).poll_read(cx, &mut limited) {
            Poll::Ready(Ok(())) if limited.filled().is_empty() => {
                this.rejected = true;
                Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()))
            }
            Poll::Ready(Ok(())) => {
                let read = limited.filled().len();
                buf.advance(read);
                this.remaining -= read;
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for BoundedSftpStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, data)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

fn unix_os_from_probe(status: Option<u32>, stdout: &str, stderr: &str) -> Option<&'static str> {
    if status != Some(0) || !stderr.is_empty() {
        return None;
    }
    match stdout {
        "Linux" => Some("linux"),
        "Darwin" => Some("macos"),
        _ => None,
    }
}

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
    pub(super) handle: Handle<ClientHandler>,
}

/// Phase of a recursive delete reported through the `sftp-remove-progress`
/// event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemovePhase {
    Scanning,
    Deleting,
}

impl RemovePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            RemovePhase::Scanning => "scanning",
            RemovePhase::Deleting => "deleting",
        }
    }
}

/// One finished step of a recursive delete, forwarded to the webview so the
/// explorer can render a live progress bar.
#[derive(Clone, Debug)]
pub struct RemoveProgress {
    pub phase: RemovePhase,
    pub deleted: usize,
    pub total: Option<usize>,
    pub current: String,
}

fn last_path_segment(path: &str) -> String {
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
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

    pub(super) async fn exec_capture(
        &self,
        command: &str,
    ) -> Result<(Option<u32>, String, String), SshError> {
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
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }

        let out = String::from_utf8_lossy(&stdout).trim().to_string();
        let err = String::from_utf8_lossy(&stderr).trim().to_string();

        Ok((exit_status, out, err))
    }
    // SFTP v3 cannot expose a macOS file's inherited ACL through FSTAT. Open,
    // attest and write through the same remote descriptor instead of checking a
    // pathname that another account in a shared directory can rename.
    async fn save_private_macos_copy(&self, path: &str, data: &[u8]) -> Result<String, SshError> {
        let script = r#"
import ctypes, errno, os, stat, sys
fd = None
try:
    path, length = sys.argv[1], int(sys.argv[2])
    os.umask(0o077)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    created = os.fstat(fd)
    if (not stat.S_ISREG(created.st_mode) or stat.S_IMODE(created.st_mode) != 0o600
            or created.st_uid != os.geteuid()):
        raise ValueError("remote server did not create a private regular file")
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libc.acl_get_fd.argtypes = [ctypes.c_int]
    libc.acl_get_fd.restype = ctypes.c_void_p
    libc.acl_free.argtypes = [ctypes.c_void_p]
    libc.acl_free.restype = ctypes.c_int
    ctypes.set_errno(0)
    acl = libc.acl_get_fd(fd)
    if acl:
        libc.acl_free(acl)
        raise ValueError("remote saved copy has an inherited ACL")
    if ctypes.get_errno() != errno.ENOENT:
        raise ValueError("cannot verify remote saved copy has no inherited ACL")
    sys.stdout.write("READY\n")
    sys.stdout.flush()
    remaining = length
    while remaining:
        chunk = sys.stdin.buffer.read(min(65536, remaining))
        if not chunk:
            raise ValueError("incomplete remote saved copy")
        view = memoryview(chunk)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise ValueError("remote write made no progress")
            view = view[written:]
        remaining -= len(chunk)
    os.fsync(fd)
    saved = os.fstat(fd)
    if (not stat.S_ISREG(saved.st_mode) or stat.S_IMODE(saved.st_mode) != 0o600
            or saved.st_uid != os.geteuid()
            or saved.st_size != length):
        raise ValueError("remote saved copy has unexpected size or permissions")
    current = os.stat(path, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (saved.st_dev, saved.st_ino):
        raise ValueError("remote saved copy was moved during save")
    sys.stdout.write("{}:{}\n".format(saved.st_size, int(saved.st_mtime)))
    sys.stdout.flush()
    os.close(fd)
    fd = None
except Exception as error:
    if fd is not None:
        # A shared parent can change this name; only the descriptor is ours.
        # Truncate any partial bytes instead of unlinking a substituted path.
        try:
            os.ftruncate(fd, 0)
            os.fsync(fd)
        except OSError as cleanup_error:
            sys.stderr.write("Remote partial-copy cleanup failed: {}\n".format(cleanup_error))
    sys.stderr.write("Remote Save copy failed: {}\n".format(error))
    sys.exit(1)
finally:
    if fd is not None:
        os.close(fd)
"#;
        let command = format!(
            "/usr/bin/python3 -c '{}' '{}' {}",
            script.replace('\'', "'\\''"),
            path.replace('\'', "'\\''"),
            data.len()
        );
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        channel
            .exec(true, command.as_str())
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut status = None;
        while !stdout.starts_with(b"READY\n") {
            let message = tokio::time::timeout_at(deadline, channel.wait())
                .await
                .map_err(|_| SshError::SessionError("Remote Save copy timed out".to_string()))?;
            match message {
                Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
            if stdout.len() + stderr.len() > MAX_EXEC_CAPTURE_BYTES {
                return Err(SshError::SessionError(
                    "Remote Save copy output exceeded 64 KiB".to_string(),
                ));
            }
            if !b"READY\n".starts_with(&stdout) && !stdout.starts_with(b"READY\n") {
                break;
            }
        }
        if !stdout.starts_with(b"READY\n") || !stderr.is_empty() || status.is_some() {
            return Err(SshError::SessionError(format!(
                "Cannot verify private remote saved copy: {}",
                String::from_utf8_lossy(&stderr).trim()
            )));
        }
        tokio::time::timeout_at(deadline, async {
            for chunk in data.chunks(SSH_DATA_CHUNK_BYTES) {
                channel.data(chunk).await?;
            }
            channel.eof().await
        })
        .await
        .map_err(|_| SshError::SessionError("Remote Save copy timed out".to_string()))??;

        loop {
            let message = tokio::time::timeout_at(deadline, channel.wait())
                .await
                .map_err(|_| SshError::SessionError("Remote Save copy timed out".to_string()))?;
            match message {
                Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
            if stdout.len() + stderr.len() > MAX_EXEC_CAPTURE_BYTES {
                return Err(SshError::SessionError(
                    "Remote Save copy output exceeded 64 KiB".to_string(),
                ));
            }
        }
        if status != Some(0) || !stderr.is_empty() {
            return Err(SshError::SessionError(format!(
                "Remote Save copy failed: {}",
                String::from_utf8_lossy(&stderr).trim()
            )));
        }
        let output =
            std::str::from_utf8(&stdout).map_err(|e| SshError::SessionError(e.to_string()))?;
        let version = output
            .strip_prefix("READY\n")
            .and_then(|rest| rest.strip_suffix('\n'))
            .filter(|version| {
                version.split_once(':').is_some_and(|(size, mtime)| {
                    size.parse::<usize>() == Ok(data.len()) && mtime.parse::<u64>().is_ok()
                })
            })
            .ok_or_else(|| {
                SshError::SessionError("Invalid remote saved copy acknowledgment".to_string())
            })?;
        Ok(version.to_string())
    }

    pub async fn detect_remote_os(&self) -> Result<String, SshError> {
        // A shell startup banner may contain an unrelated OS name. Only a
        // successful, unambiguous uname reply can bypass the macOS ACL probe.
        if let Ok((status, stdout, stderr)) = self.exec_capture("uname -s").await {
            if let Some(os) = unix_os_from_probe(status, &stdout, &stderr) {
                return Ok(os.to_string());
            }
        }
        if let Ok((Some(0), stdout, stderr)) = self.exec_capture("cmd /c ver").await {
            if stderr.is_empty()
                && stdout.starts_with("Microsoft Windows [Version ")
                && stdout.ends_with(']')
            {
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

        SftpSession::new(BoundedSftpStream::new(channel.into_stream()))
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

    pub async fn home_dir_via_sftp(&self) -> Result<String, SshError> {
        let sftp = self.open_sftp().await?;
        sftp.canonicalize(".")
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))
    }

    pub async fn file_size_via_sftp(&self, path: &str) -> Result<Option<u64>, SshError> {
        let sftp = self.open_sftp().await?;
        Ok(sftp
            .metadata(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?
            .size)
    }

    pub async fn list_dir_via_sftp(&self, path: &str) -> Result<Vec<SftpDirEntry>, SshError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        // SftpSession::read_dir collects every READDIR response before returning.
        // The guarded stream bounds each raw server response to 1 MiB;
        // consume batches and stop before the remote server can grow our vector.
        let session = RawSftpSession::new(BoundedSftpStream::new(channel.into_stream()));
        session
            .init()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        let directory = session
            .opendir(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?
            .handle;
        let mut entries = Vec::new();
        let mut name_bytes = 0usize;
        let mut responses = 0usize;
        let result = async {
            loop {
                let batch = match session.readdir(directory.as_str()).await {
                    Ok(batch) => batch,
                    Err(russh_sftp::client::error::Error::Status(status))
                        if status.status_code == StatusCode::Eof =>
                    {
                        break
                    }
                    Err(error) => return Err(SshError::SessionError(error.to_string())),
                };
                responses += 1;
                if responses > MAX_SFTP_LIST_ENTRIES {
                    return Err(SshError::SessionError(
                        "Remote directory did not finish listing".to_string(),
                    ));
                }
                for entry in batch.files {
                    name_bytes = name_bytes
                        .checked_add(entry.filename.len() + entry.longname.len())
                        .ok_or_else(|| {
                            SshError::SessionError(
                                "Remote directory listing is too large".to_string(),
                            )
                        })?;
                    if name_bytes > MAX_SFTP_LIST_NAME_BYTES {
                        return Err(SshError::SessionError(
                            "Remote directory listing is too large".to_string(),
                        ));
                    }
                    let name = entry.filename;
                    if name == "." || name == ".." {
                        continue;
                    }
                    if entries.len() >= MAX_SFTP_LIST_ENTRIES {
                        return Err(SshError::SessionError(
                            "Remote directory contains more than 10,000 entries; listing was not loaded".to_string(),
                        ));
                    }
                    let metadata = entry.attrs;
                    let mut is_dir = metadata.file_type().is_dir();
                    // Resolve symlink and Other-type entries so directory links
                    // remain navigable, without materializing the rest of a listing.
                    if !is_dir && !metadata.file_type().is_file() {
                        let entry_path = if path.is_empty() {
                            name.clone()
                        } else if path.ends_with('/') {
                            format!("{path}{name}")
                        } else {
                            format!("{path}/{name}")
                        };
                        if let Ok(target) = session.stat(entry_path).await {
                            is_dir = target.attrs.file_type().is_dir();
                        }
                    }
                    entries.push(SftpDirEntry {
                        is_dir,
                        name,
                        size: metadata.size.unwrap_or(0),
                        mtime: metadata.mtime.map(|value| value as i64).unwrap_or(0),
                    });
                }
            }
            Ok(entries)
        }
        .await;
        let close = session
            .close(directory)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()));
        let mut entries = result.and_then(|entries| close.map(|_| entries))?;
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn create_dir_via_sftp(&self, path: &str) -> Result<(), SshError> {
        let sftp = self.open_sftp().await?;
        sftp.create_dir(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))
    }

    pub async fn create_file_via_sftp(&self, path: &str) -> Result<(), SshError> {
        let sftp = self.open_sftp().await?;
        let file_permissions = FileAttributes {
            permissions: Some(0o644),
            ..FileAttributes::default()
        };
        let mut file = sftp
            .open_with_flags_and_attributes(
                path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                file_permissions,
            )
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        file.shutdown()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))
    }

    pub async fn remove_path_via_sftp(
        &self,
        path: &str,
        on_progress: Option<&(dyn Fn(RemoveProgress) + Send + Sync)>,
    ) -> Result<(), SshError> {
        let sftp = self.open_sftp().await?;
        // LSTAT semantics: a symlink to a directory is unlinked as a link
        // instead of deleting the target's contents.
        let metadata = sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        if !metadata.file_type().is_dir() {
            return sftp
                .remove_file(path)
                .await
                .map_err(|e| SshError::SessionError(e.to_string()));
        }
        // SFTP v3 cannot bind descendant paths to directory handles. Never walk
        // a remote tree here: RMDIR rejects non-empty directories atomically.
        if let Some(progress) = on_progress {
            progress(RemoveProgress {
                phase: RemovePhase::Deleting,
                deleted: 0,
                total: Some(1),
                current: last_path_segment(path),
            });
        }
        sftp.remove_dir(path).await.map_err(|error| {
            SshError::SessionError(format!(
                "Unable to delete this remote folder. Only empty folders are supported. {error}"
            ))
        })?;
        if let Some(progress) = on_progress {
            progress(RemoveProgress {
                phase: RemovePhase::Deleting,
                deleted: 1,
                total: Some(1),
                current: last_path_segment(path),
            });
        }
        Ok(())
    }

    pub async fn read_file_via_sftp(
        &self,
        path: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, SshError> {
        self.read_file_with_attributes_via_sftp(path, max_bytes)
            .await
            .map(|(data, _)| data)
    }

    async fn read_file_with_attributes_via_sftp(
        &self,
        path: &str,
        max_bytes: u64,
    ) -> Result<(Vec<u8>, FileAttributes), SshError> {
        let sftp = self.open_sftp().await?;
        let attributes = sftp
            .metadata(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        if let Some(size) = attributes.size {
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
        Ok((data, attributes))
    }

    pub async fn read_file_with_version_via_sftp(
        &self,
        path: &str,
        max_bytes: u64,
    ) -> Result<(Vec<u8>, Option<String>), SshError> {
        let (data, attributes) = self
            .read_file_with_attributes_via_sftp(path, max_bytes)
            .await?;
        let version = attributes
            .size
            .zip(attributes.mtime)
            .map(|(size, mtime)| format!("{size}:{mtime}"));
        Ok((data, version))
    }

    async fn verify_save_copy_parent(
        &self,
        sftp: &SftpSession,
        parent: &str,
        remote_os: &str,
    ) -> Result<Option<u32>, SshError> {
        let parent = if parent.is_empty() { "/" } else { parent };
        if !parent.starts_with('/')
            || parent.contains('\0')
            || parent
                .split('/')
                .any(|component| component == "." || component == "..")
        {
            return Err(SshError::SessionError(
                "Invalid remote Save copy directory".to_string(),
            ));
        }
        if remote_os == "macos" {
            super::upload::verify_macos_stage_parent(self, parent, false)
                .await
                .map_err(|error| {
                    SshError::SessionError(format!(
                        "Remote Save copy directory is not protected: {error}"
                    ))
                })?;
            return Ok(None);
        }
        let (status, stdout, stderr) = self.exec_capture("id -u").await?;
        if status != Some(0) || !stderr.is_empty() {
            return Err(SshError::SessionError(
                "Cannot verify remote Save copy directory owner".to_string(),
            ));
        }
        let uid = stdout.trim().parse::<u32>().map_err(|_| {
            SshError::SessionError("Cannot verify remote Save copy directory owner".to_string())
        })?;
        let mut current = String::from("/");
        for component in
            std::iter::once("").chain(parent.split('/').filter(|part| !part.is_empty()))
        {
            if !component.is_empty() {
                if current.len() > 1 {
                    current.push('/');
                }
                current.push_str(component);
            }
            let attrs = sftp.symlink_metadata(&current).await.map_err(|error| {
                SshError::SessionError(format!("Cannot verify remote Save copy directory: {error}"))
            })?;
            if !attrs.file_type().is_dir()
                || !attrs
                    .uid
                    .zip(attrs.permissions)
                    .is_some_and(|(owner, mode)| {
                        super::upload::safe_stage_component(owner, uid, mode, false)
                    })
            {
                return Err(SshError::SessionError(
                    "Remote Save copy directory can be renamed by another account".to_string(),
                ));
            }
        }
        Ok(Some(uid))
    }

    pub async fn save_copy_via_sftp(
        &self,
        path: &str,
        data: &[u8],
        expected_data: &[u8],
        max_bytes: u64,
    ) -> Result<crate::SavedFileCopy, SshError> {
        if data.len() as u64 > max_bytes || expected_data.len() as u64 > max_bytes {
            return Err(SshError::SessionError(format!(
                "File is too large to save ({} byte limit)",
                max_bytes
            )));
        }
        let _write_guard = crate::FILE_WRITE_LOCK.lock().await;
        let remote_os = self.detect_remote_os().await?;
        if remote_os != "linux" && remote_os != "macos" {
            return Err(SshError::SessionError(
                "Cannot verify permissions on this SFTP server".to_string(),
            ));
        }
        let sftp = self.open_sftp().await?;
        let resolved_path = sftp
            .canonicalize(path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        let metadata = sftp
            .metadata(&resolved_path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        if !metadata.file_type().is_file() {
            return Err(SshError::SessionError("Not a regular file".to_string()));
        }
        if self.read_file_via_sftp(&resolved_path, max_bytes).await? != expected_data {
            return Err(SshError::SessionError(
                "File changed since it was opened. Reload before saving.".to_string(),
            ));
        }

        let (parent, name) = resolved_path.rsplit_once('/').ok_or_else(|| {
            SshError::SessionError("Resolved SFTP path has no parent directory".to_string())
        })?;
        let exec_uid = self
            .verify_save_copy_parent(&sftp, parent, &remote_os)
            .await?;
        let (stem, extension) = match name.rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
                (stem, format!(".{extension}"))
            }
            _ => (name, String::new()),
        };
        let stem = match stem.rsplit_once(".redterm-") {
            Some((base, suffix)) if !base.is_empty() && uuid::Uuid::parse_str(suffix).is_ok() => {
                base
            }
            _ => stem,
        };
        let marker = format!(".redterm-{}", uuid::Uuid::new_v4());
        let stem_limit = 240usize
            .checked_sub(marker.len() + extension.len())
            .ok_or_else(|| {
                SshError::SessionError("File extension is too long for a saved copy".to_string())
            })?;
        let mut end = stem.len().min(stem_limit);
        while !stem.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 {
            return Err(SshError::SessionError(
                "File name is too long for a saved copy".to_string(),
            ));
        }
        let copy_name = format!("{}{marker}{extension}", &stem[..end]);
        let copy_path = if parent.is_empty() {
            format!("/{copy_name}")
        } else {
            format!("{parent}/{copy_name}")
        };
        if remote_os == "macos" {
            let version = self.save_private_macos_copy(&copy_path, data).await?;
            // Exec and SFTP may be different namespaces on custom servers.
            // Never retarget the editor unless its actual SFTP view sees this copy.
            if self.read_file_via_sftp(&copy_path, max_bytes).await? != data {
                return Err(SshError::SessionError(
                    "Saved copy is not available through this SFTP session".to_string(),
                ));
            }
            return Ok(crate::SavedFileCopy {
                path: copy_path,
                version: Some(version),
            });
        }
        // SFTP v3 cannot preserve ACLs or xattrs. Do not clone metadata from the
        // source; create private and fail closed if effective mode is broader.
        let create_attributes = FileAttributes {
            permissions: Some(0o600),
            ..FileAttributes::default()
        };
        let mut file = sftp
            .open_with_flags_and_attributes(
                &copy_path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                create_attributes,
            )
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        // FSTAT the open handle, not a path that could name another file.
        // On POSIX an inherited default ACL granting group/other effective access
        // is reflected in the mode mask; refuse a non-private file before writing.
        let result = async {
            let created = file
                .metadata()
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
            if !created.file_type().is_file()
                || created.uid != exec_uid
                || !matches!(created.permissions, Some(mode) if mode & 0o777 == 0o600)
            {
                return Err(SshError::SessionError(
                    "Remote server did not create a private regular file".to_string(),
                ));
            }
            file.write_all(data)
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
            file.flush()
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
            let saved = file
                .metadata()
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
            if saved.size != Some(data.len() as u64)
                || !saved.file_type().is_file()
                || saved.uid != exec_uid
                || !matches!(saved.permissions, Some(mode) if mode & 0o777 == 0o600)
            {
                return Err(SshError::SessionError(
                    "Remote saved copy has unexpected size or permissions".to_string(),
                ));
            }
            let version = saved
                .size
                .zip(saved.mtime)
                .map(|(size, mtime)| format!("{size}:{mtime}"));
            Ok(crate::SavedFileCopy {
                path: copy_path.clone(),
                version,
            })
        }
        .await;
        // Close even after a failed FSTAT/write; dropping the handle does not wait for
        // pending write errors or a CLOSE response in russh-sftp.
        let close_result = file
            .close()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()));
        let result = result.and_then(|saved| close_result.map(|()| saved));
        if result.is_err() {
            // EXCLUDE established ownership of this random name. Never remove the source.
            if let Err(cleanup) = sftp.remove_file(&copy_path).await {
                return Err(SshError::SessionError(format!(
                    "{}; failed to remove incomplete copy {copy_path}: {cleanup}",
                    result.unwrap_err()
                )));
            }
        }
        result
    }
    pub async fn download_file_via_sftp(
        &self,
        remote_path: &str,
        destination_file: &mut tokio::fs::File,
        max_bytes: u64,
        on_progress: Option<&(dyn Fn(u64) + Send + Sync)>,
    ) -> Result<u64, SshError> {
        let sftp = self.open_sftp().await?;
        let mut total_size: Option<u64> = None;
        if let Some(size) = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?
            .size
        {
            total_size = Some(size);
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

        // Write through the pre-claimed exclusive handle. Re-opening the path
        // here would let a symlink swap redirect the write after the claim.
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
            destination_file
                .write_all(&buffer[..read])
                .await
                .map_err(|e| SshError::SessionError(e.to_string()))?;
            if let Some(on_progress) = on_progress {
                on_progress(total.min(total_size.unwrap_or(total)));
            }
        }
        destination_file
            .flush()
            .await
            .map_err(|e| SshError::SessionError(e.to_string()))?;
        // Always report the final position so progress bars can complete
        // even when the advertised size was missing.
        if let Some(on_progress) = on_progress {
            on_progress(total.min(total_size.unwrap_or(total)));
        }

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
    #[test]
    fn remote_os_probe_rejects_shell_banners_and_unsuccessful_commands() {
        use super::unix_os_from_probe;

        assert_eq!(unix_os_from_probe(Some(0), "Darwin", ""), Some("macos"));
        assert_eq!(unix_os_from_probe(Some(0), "Linux", ""), Some("linux"));
        assert_eq!(
            unix_os_from_probe(Some(0), "Linux environment available\nDarwin", ""),
            None
        );
        assert_eq!(unix_os_from_probe(Some(1), "Linux", ""), None);
        assert_eq!(unix_os_from_probe(None, "Linux", ""), None);
        assert_eq!(unix_os_from_probe(Some(0), "Darwin", "startup error"), None);
    }

    #[tokio::test]
    async fn bounded_sftp_stream_accepts_fragmented_frame_and_rejects_oversized_response() {
        use super::BoundedSftpStream;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (mut server, client) = tokio::io::duplex(64);
        let sender = tokio::spawn(async move {
            for byte in 5u32.to_be_bytes() {
                server.write_all(&[byte]).await.unwrap();
                tokio::task::yield_now().await;
            }
            server.write_all(b"hello").await.unwrap();
            server.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
        });
        let mut stream = BoundedSftpStream::new(client);
        assert_eq!(stream.read_u32().await.unwrap(), 5);
        let mut payload = [0u8; 5];
        stream.read_exact(&mut payload).await.unwrap();
        assert_eq!(&payload, b"hello");
        let error = stream
            .read_u32()
            .await
            .expect_err("oversized frame must not allocate");
        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        sender.await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn sftp_save_copy_preserves_original_and_prior_revisions() {
        use super::{AuthConfig, AuthMethod, SshConnection};
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Child, Command, Stdio};
        use std::time::Duration;

        struct ServerFixture {
            root: PathBuf,
            child: Child,
        }
        impl Drop for ServerFixture {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                let _ = fs::remove_dir_all(&self.root);
            }
        }
        let root = std::env::temp_dir().join(format!("redterm-sftp-save-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let key = root.join("client_key");
        let host_key = root.join("host_key");
        for path in [&key, &host_key] {
            let generated = Command::new("/usr/bin/ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(path)
                .status()
                .expect("ssh-keygen available on macOS");
            assert!(generated.success());
        }
        fs::copy(key.with_extension("pub"), root.join("authorized_keys")).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let known_hosts = root.join("known_hosts");
        fs::write(
            &known_hosts,
            format!(
                "[127.0.0.1]:{port} {}",
                fs::read_to_string(host_key.with_extension("pub")).unwrap()
            ),
        )
        .unwrap();
        let config = root.join("sshd_config");
        fs::write(&config, format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nSubsystem sftp internal-sftp\nPidFile {}\nLogLevel ERROR\n",
            host_key.display(), root.join("authorized_keys").display(), root.join("sshd.pid").display()
        )).unwrap();
        let child = Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(&config)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sshd available on macOS");
        let mut fixture = ServerFixture { root, child };
        let mut ready = false;
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            assert!(
                fixture.child.try_wait().unwrap().is_none(),
                "isolated sshd exited"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(ready, "isolated sshd did not start");
        let connection = SshConnection::connect(
            "127.0.0.1",
            port,
            AuthConfig {
                username: std::env::var("USER").unwrap(),
                method: AuthMethod::ResolvedKey {
                    key_path: key.to_str().unwrap().to_owned(),
                    passphrase: None,
                },
            },
            known_hosts,
        )
        .await
        .expect("connect to isolated OpenSSH");
        let probe = connection
            .exec_capture("uname -s")
            .await
            .expect("remote shell probe");
        assert_eq!(probe, (Some(0), "Darwin".to_string(), String::new()));
        let source = fixture.root.join("document.md");
        fs::write(&source, b"original").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();
        let source_name = source.to_str().unwrap();
        let first = connection
            .save_copy_via_sftp(source_name, b"first", b"original", 1024)
            .await
            .expect("first private copy");
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert_eq!(fs::read(&first.path).unwrap(), b"first");
        assert!(first.path.ends_with(".md"));
        assert_eq!(
            fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(first.version.as_deref().unwrap().starts_with("5:"));
        let second = connection
            .save_copy_via_sftp(&first.path, b"second", b"first", 1024)
            .await
            .expect("second private copy");
        assert_eq!(
            std::path::Path::new(&first.path).file_name().unwrap().len(),
            std::path::Path::new(&second.path)
                .file_name()
                .unwrap()
                .len(),
            "successive saves replace rather than accumulate revision markers"
        );
        assert_ne!(first.path, second.path);
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert_eq!(fs::read(&first.path).unwrap(), b"first");
        assert_eq!(fs::read(&second.path).unwrap(), b"second");
        let empty_source = fixture.root.join("empty.md");
        fs::write(&empty_source, b"").unwrap();
        let empty_copy = connection
            .save_copy_via_sftp(empty_source.to_str().unwrap(), b"", b"", 1024)
            .await
            .expect("empty document copy must be acknowledged without a stdin payload");
        assert_eq!(fs::read(&empty_copy.path).unwrap(), b"");
        assert!(empty_copy.version.as_deref().unwrap().starts_with("0:"));
        let long_source = fixture.root.join(format!("{}.txt", "é".repeat(105)));
        fs::write(&long_source, b"long source").unwrap();
        let long_copy = connection
            .save_copy_via_sftp(
                long_source.to_str().unwrap(),
                b"long copy",
                b"long source",
                1024,
            )
            .await
            .expect("a valid long UTF-8 source name must have a valid private copy name");
        let long_leaf = std::path::Path::new(&long_copy.path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        assert!(long_leaf.len() <= 240 && long_leaf.ends_with(".txt"));
        assert_eq!(fs::read(&long_source).unwrap(), b"long source");
        assert_eq!(fs::read(&long_copy.path).unwrap(), b"long copy");
        let quoted_source = fixture.root.join("report's #1.md");
        fs::write(&quoted_source, b"quoted original").unwrap();
        let quoted_copy = connection
            .save_copy_via_sftp(
                quoted_source.to_str().unwrap(),
                b"quoted copy",
                b"quoted original",
                1024,
            )
            .await
            .expect("shell-quoted remote paths must preserve the exact source and revision");
        assert_eq!(fs::read(&quoted_source).unwrap(), b"quoted original");
        assert_eq!(fs::read(&quoted_copy.path).unwrap(), b"quoted copy");
        let listing_dir = fixture.root.join("explorer-listing");
        fs::create_dir(&listing_dir).unwrap();
        fs::create_dir(listing_dir.join("alpha")).unwrap();
        std::os::unix::fs::symlink("alpha", listing_dir.join("linked")).unwrap();
        fs::write(listing_dir.join("b.txt"), b"contents").unwrap();
        let listed = connection
            .list_dir_via_sftp(listing_dir.to_str().unwrap())
            .await
            .expect("incremental SSH explorer listing");
        assert_eq!(
            listed
                .iter()
                .map(|entry| (entry.name.as_str(), entry.is_dir))
                .collect::<Vec<_>>(),
            [("alpha", true), ("linked", true), ("b.txt", false)]
        );
        assert_eq!(listed[2].size, 8);
        let upload_source = fixture.root.join("upload-source.bin");
        let upload_bytes = vec![0xa5; 64 * 1024 + 3];
        fs::write(&upload_source, &upload_bytes).unwrap();
        let upload = connection
            .upload_paths_via_sftp(
                listing_dir.to_str().unwrap(),
                vec![upload_source.clone()],
                crate::ssh::upload::UploadSelectionKind::Files,
                &|_| {},
            )
            .await
            .expect("guarded raw SFTP upload channel");
        assert!(
            upload.failed.is_empty(),
            "{} upload failures",
            upload.failed.len()
        );
        assert_eq!(upload.uploaded.len(), 1);
        assert_eq!(
            fs::read(&upload.uploaded[0].remote_path).unwrap(),
            upload_bytes
        );
        assert_eq!(fs::read(&upload_source).unwrap(), upload_bytes);
        let oversized_dir = fixture.root.join("oversized-listing");
        fs::create_dir(&oversized_dir).unwrap();
        for number in 0..super::MAX_SFTP_LIST_ENTRIES {
            fs::write(oversized_dir.join(format!("{number:05}")), b"").unwrap();
        }
        assert_eq!(
            connection
                .list_dir_via_sftp(oversized_dir.to_str().unwrap())
                .await
                .expect("exactly 10,000 entries is complete")
                .len(),
            super::MAX_SFTP_LIST_ENTRIES
        );
        fs::write(oversized_dir.join("overflow"), b"").unwrap();
        connection
            .list_dir_via_sftp(oversized_dir.to_str().unwrap())
            .await
            .expect_err("a partial remote listing cannot masquerade as complete");
        let acl_dir = fixture.root.join("inherited-acl");
        fs::create_dir(&acl_dir).unwrap();
        assert!(Command::new("/bin/chmod")
            .args(["+a", "everyone allow read,file_inherit"])
            .arg(&acl_dir)
            .status()
            .unwrap()
            .success());
        let acl_source = acl_dir.join("acl-source.md");
        fs::write(&acl_source, b"private source").unwrap();
        connection
            .save_copy_via_sftp(
                acl_source.to_str().unwrap(),
                b"private copy",
                b"private source",
                1024,
            )
            .await
            .expect_err("inherited ACL must not leak saved content");
        assert_eq!(fs::read(&acl_source).unwrap(), b"private source");
        // A path in a shared directory cannot be safely unlinked after failure:
        // another account could have swapped that name. Any orphan must be empty.
        for entry in fs::read_dir(&acl_dir).unwrap() {
            let path = entry.unwrap().path();
            if path != acl_source {
                assert_eq!(
                    fs::read(&path).unwrap(),
                    b"",
                    "failed copy leaked edited bytes"
                );
            }
        }
        let shared_dir = fixture.root.join("shared");
        fs::create_dir(&shared_dir).unwrap();
        fs::set_permissions(&shared_dir, fs::Permissions::from_mode(0o777)).unwrap();
        let shared_source = shared_dir.join("source.md");
        fs::write(&shared_source, b"original shared").unwrap();
        connection
            .save_copy_via_sftp(
                shared_source.to_str().unwrap(),
                b"private",
                b"original shared",
                1024,
            )
            .await
            .expect_err(
                "another account must not replace a newly saved revision in a nonsticky directory",
            );
        assert_eq!(fs::read(&shared_source).unwrap(), b"original shared");
        assert_eq!(fs::read_dir(&shared_dir).unwrap().count(), 1);
        fs::set_permissions(&shared_dir, fs::Permissions::from_mode(0o1777)).unwrap();
        let sticky_copy = connection
            .save_copy_via_sftp(
                shared_source.to_str().unwrap(),
                b"private",
                b"original shared",
                1024,
            )
            .await
            .expect("sticky shared directory must protect this account's new file name");
        assert_eq!(fs::read(&sticky_copy.path).unwrap(), b"private");
        assert_eq!(fs::read(&shared_source).unwrap(), b"original shared");
        assert_eq!(
            fs::metadata(&second.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::write(&source, b"external").unwrap();
        connection
            .save_copy_via_sftp(source_name, b"mine", b"original", 1024)
            .await
            .expect_err("stale content cannot be saved");
        assert_eq!(fs::read(&source).unwrap(), b"external");
        assert_eq!(fs::read(&first.path).unwrap(), b"first");
        assert_eq!(fs::read(&second.path).unwrap(), b"second");
    }
}

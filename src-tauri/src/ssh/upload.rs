#[cfg(unix)]
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh_sftp::client::{error::Error as SftpError, RawSftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use tokio::io::AsyncReadExt;

use super::client::BoundedSftpStream;
use super::{SshConnection, SshError};
use crate::storage::unique_destination_names;
const MAX_LOCAL_COPY_ENTRIES: usize = 10_000;
const MAX_LOCAL_COPY_DEPTH: usize = 64;
// SFTPv3 servers must support 32 KiB writes. Only one owned packet is in flight;
// the raw API consumes its Vec, so no file-sized allocation or copy is needed.
const UPLOAD_CHUNK_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadSelectionKind {
    Files,
    Folder,
}

impl UploadSelectionKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "files" => Ok(Self::Files),
            "folder" => Ok(Self::Folder),
            _ => Err("Upload selection must be files or folder".to_string()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadPhase {
    Preparing,
    Uploading,
    Finishing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub phase: UploadPhase,
    pub name: String,
    pub transferred: u64,
    pub total: Option<u64>,
    pub file_index: usize,
    pub file_count: usize,
}

#[derive(Debug, Serialize)]
pub struct SftpUploadedItem {
    pub name: String,
    pub remote_path: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct SftpUploadFailure {
    pub name: String,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct SftpUploadResult {
    pub uploaded: Vec<SftpUploadedItem>,
    pub failed: Vec<SftpUploadFailure>,
}

pub(crate) struct LocalEntry {
    pub(crate) relative: PathBuf,
    pub(crate) name: String,
    pub(crate) is_dir: bool,
}

pub(crate) struct LocalFile {
    file: File,
    #[cfg(windows)]
    _parents: Vec<File>,
}

impl std::ops::Deref for LocalFile {
    type Target = File;
    fn deref(&self) -> &File {
        &self.file
    }
}

pub(crate) struct LocalSource {
    root: File,
    #[cfg(unix)]
    _ancestors: Vec<File>,
    #[cfg(windows)]
    path: PathBuf,
    #[cfg(windows)]
    _ancestors: Vec<File>,
}

fn invalid_source(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(crate) fn validate_name(name: &std::ffi::OsStr) -> io::Result<&str> {
    let name = name
        .to_str()
        .ok_or_else(|| invalid_source("File names must be valid Unicode"))?;
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err(invalid_source("Invalid upload file name"));
    }
    Ok(name)
}

pub(crate) fn validate_type(file: &File) -> io::Result<bool> {
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid_source(
                "Symbolic links and reparse points cannot be uploaded",
            ));
        }
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(invalid_source("Only regular files and folders can be uploaded; symbolic links and special files are not supported"));
    }
    Ok(metadata.is_dir())
}

#[cfg(unix)]
fn open_local_at(parent: &File, name: &std::ffi::OsStr, directory: bool) -> io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name.as_encoded_bytes())
        .map_err(|_| invalid_source("Invalid upload file name"))?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn open_local(path: &Path) -> io::Result<(File, Vec<File>)> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut components = path.components().peekable();
    if path.as_os_str().is_empty() {
        return Err(invalid_source("Select a named file or folder"));
    }
    let base = if matches!(components.peek(), Some(Component::RootDir)) {
        components.next();
        "/"
    } else {
        if matches!(components.peek(), Some(Component::CurDir)) {
            components.next();
        }
        "."
    };
    let mut parent = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(base)?;
    let mut ancestors = Vec::new();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(invalid_source("Upload path escapes the selected folder"));
        };
        let directory = components.peek().is_some();
        let child = open_local_at(&parent, name, directory)?;
        validate_type(&child)?;
        if !directory {
            ancestors.push(parent);
            return Ok((child, ancestors));
        }
        ancestors.push(parent);
        parent = child;
    }
    Ok((parent, ancestors))
}

#[cfg(windows)]
fn open_local(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        // Denying delete sharing pins the path while descendants are opened.
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    validate_type(&file)?;
    Ok(file)
}

impl LocalSource {
    pub(crate) fn new(path: &Path, folder: bool) -> io::Result<Self> {
        #[cfg(windows)]
        let (absolute_path, ancestors) = {
            // Canonicalizing before opening would follow an ancestor junction
            // before FILE_FLAG_OPEN_REPARSE_POINT can reject it. Keep the
            // picker path intact and pin each original ancestor in order.
            if !path.is_absolute()
                || path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
            {
                return Err(invalid_source(
                    "Select an absolute path without parent-directory components",
                ));
            }
            let path = path.to_path_buf();
            let mut parents = path.ancestors().skip(1).collect::<Vec<_>>();
            parents.reverse();
            let mut handles = Vec::with_capacity(parents.len());
            for parent in parents {
                handles.push(open_local(parent)?);
            }
            (path, handles)
        };
        #[cfg(windows)]
        let path = absolute_path.as_path();
        #[cfg(unix)]
        let (root, ancestors) = open_local(path)?;
        #[cfg(windows)]
        let root = open_local(path)?;
        if validate_type(&root)? != folder {
            return Err(invalid_source(if folder {
                "Select a regular folder"
            } else {
                "Select regular files"
            }));
        }
        Ok(Self {
            #[cfg(unix)]
            _ancestors: ancestors,
            root,
            #[cfg(windows)]
            path: absolute_path,
            #[cfg(windows)]
            _ancestors: ancestors,
        })
    }

    pub(crate) fn open(&self, relative: &Path) -> io::Result<LocalFile> {
        let mut file = self.root.try_clone()?;
        #[cfg(windows)]
        let mut path = self.path.clone();
        #[cfg(windows)]
        let mut parents = Vec::new();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(invalid_source("Upload path escapes the selected folder"));
            };
            #[cfg(unix)]
            {
                file = open_local_at(&file, name, false)?;
            }
            #[cfg(windows)]
            {
                parents.push(file);
                path.push(name);
                file = open_local(&path)?;
            }
            validate_type(&file)?;
        }
        Ok(LocalFile {
            file,
            #[cfg(windows)]
            _parents: parents,
        })
    }

    pub(crate) fn entries(&self, name: &str) -> io::Result<Vec<LocalEntry>> {
        let mut entries = Vec::new();
        let mut pending = vec![(PathBuf::new(), name.to_string(), 0usize)];
        while let Some((relative, name, depth)) = pending.pop() {
            if entries.len() + pending.len() >= MAX_LOCAL_COPY_ENTRIES {
                return Err(invalid_source("Selected folder contains too many entries"));
            }
            let file = self.open(&relative)?;
            let is_dir = validate_type(&file)?;
            if is_dir {
                let remaining = MAX_LOCAL_COPY_ENTRIES - entries.len() - pending.len() - 1;
                #[cfg(unix)]
                let names = directory_names(&file, remaining)?;
                #[cfg(windows)]
                let names = std::fs::read_dir(self.path.join(&relative))?
                    .take(remaining + 1)
                    .map(|entry| entry.map(|entry| entry.file_name()))
                    .collect::<io::Result<Vec<_>>>()?;
                #[cfg(windows)]
                if names.len() > remaining {
                    return Err(invalid_source("Selected folder contains too many entries"));
                }
                if depth >= MAX_LOCAL_COPY_DEPTH && !names.is_empty() {
                    return Err(invalid_source(
                        "Selected folder exceeds the copy depth limit",
                    ));
                }
                for child in names {
                    let child_name = validate_name(&child)?;
                    pending.push((
                        relative.join(&child),
                        format!("{name}/{child_name}"),
                        depth + 1,
                    ));
                }
            }
            entries.push(LocalEntry {
                relative,
                name,
                is_dir,
            });
        }
        Ok(entries)
    }
}

#[cfg(unix)]
fn directory_names(file: &File, limit: usize) -> io::Result<Vec<OsString>> {
    use std::os::fd::IntoRawFd;
    use std::os::unix::ffi::OsStringExt;
    let fd = file.try_clone()?.into_raw_fd();
    let dir = unsafe { libc::fdopendir(fd) };
    if dir.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        return Err(error);
    }
    let mut names = Vec::new();
    let result = loop {
        #[cfg(target_os = "macos")]
        let errno = unsafe { libc::__error() };
        #[cfg(target_os = "linux")]
        let errno = unsafe { libc::__errno_location() };
        unsafe {
            *errno = 0;
        }
        let entry = unsafe { libc::readdir(dir) };
        if entry.is_null() {
            break if unsafe { *errno } == 0 {
                Ok(names)
            } else {
                Err(io::Error::last_os_error())
            };
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            if names.len() == limit {
                break Err(invalid_source("Selected folder contains too many entries"));
            }
            names.push(OsString::from_vec(name.to_vec()));
        }
    };
    unsafe {
        libc::closedir(dir);
    }
    result
}

fn remote_child(parent: &str, name: &str) -> String {
    format!("{}/{name}", parent.trim_end_matches('/'))
}

fn sftp_error(error: impl std::fmt::Display) -> SshError {
    SshError::SessionError(error.to_string())
}

fn missing(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}
pub(super) fn safe_stage_component(uid: u32, owner: u32, mode: u32, stage: bool) -> bool {
    (uid == owner || uid == 0)
        && (mode & 0o022 == 0 || mode & 0o1000 != 0)
        && (!stage || (uid == owner && mode & 0o7777 == 0o700))
}
// Linux ACL access masks are represented by group mode bits: a 0700
// directory cannot grant named users traversal on Linux.
async fn verify_linux_stage_parent(
    sftp: &RawSftpSession,
    path: &str,
    owner: u32,
    stage: bool,
) -> Result<(), SshError> {
    let root = sftp.lstat("/").await.map_err(sftp_error)?.attrs;
    if !root.file_type().is_dir()
        || !root
            .uid
            .zip(root.permissions)
            .is_some_and(|(uid, mode)| safe_stage_component(uid, owner, mode, stage && path == "/"))
    {
        return Err(sftp_error("Remote staging directory root is not protected"));
    }
    let mut current = String::new();
    for component in path.split('/').filter(|part| !part.is_empty()) {
        current.push('/');
        current.push_str(component);
        let attrs = sftp.lstat(&current).await.map_err(sftp_error)?.attrs;
        let uid = attrs
            .uid
            .ok_or_else(|| sftp_error("Remote directory owner is unavailable"))?;
        let mode = attrs
            .permissions
            .ok_or_else(|| sftp_error("Remote directory mode is unavailable"))?;
        if !attrs.file_type().is_dir()
            || !safe_stage_component(uid, owner, mode, current == path && stage)
        {
            return Err(sftp_error("Remote staging directory is not private"));
        }
    }
    Ok(())
}

// macOS ACLs are not exposed by SFTPv3. Traverse through O_NOFOLLOW
// descriptors and check each ACL before creating any payload.
pub(super) async fn verify_macos_stage_parent(
    connection: &SshConnection,
    path: &str,
    stage: bool,
) -> Result<(), SshError> {
    let script = r#"
import ctypes, errno, os, stat, sys
path, stage = sys.argv[1], sys.argv[2] == '1'
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
libc.acl_get_fd.argtypes = [ctypes.c_int]
libc.acl_get_fd.restype = ctypes.c_void_p
libc.acl_free.argtypes = [ctypes.c_void_p]
libc.acl_free.restype = ctypes.c_int
if not path.startswith('/') or '\x00' in path or any(p in ('.', '..') for p in path.split('/')):
    raise ValueError('invalid staging path')
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    for component in [''] + [p for p in path.split('/') if p]:
        if component:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.geteuid())
                or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX)):
            raise ValueError('staging ancestor is writable by another account')
        ctypes.set_errno(0)
        acl = libc.acl_get_fd(fd)
        if acl:
            libc.acl_free(acl)
            raise ValueError('staging ancestor has an ACL')
        if ctypes.get_errno() != errno.ENOENT:
            raise ValueError('cannot verify staging ancestor ACL')
    if stage and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError('staging directory is not owned and private')
    print('PRIVATE')
finally:
    os.close(fd)
"#;
    let command = format!(
        "/usr/bin/python3 -c '{}' '{}' {}",
        script.replace('\'', "'\\''"),
        path.replace('\'', "'\\''"),
        if stage { 1 } else { 0 }
    );
    let (status, stdout, stderr) = connection.exec_capture(&command).await?;
    if status != Some(0) || stdout != "PRIVATE" || !stderr.is_empty() {
        return Err(sftp_error(format!(
            "Cannot verify private remote staging directory: {stderr}"
        )));
    }
    Ok(())
}

async fn commit_upload(
    sftp: &RawSftpSession,
    stage: &str,
    destination: &str,
    name: &str,
) -> Result<String, SshError> {
    for candidate in unique_destination_names(name) {
        let target = remote_child(destination, &candidate);
        match sftp.lstat(&target).await {
            Ok(_) => continue, // Includes dangling symlinks and empty directories.
            Err(error) if missing(&error) => {}
            Err(error) => return Err(sftp_error(error)),
        }
        // RawSftpSession::rename sends SSH_FXP_RENAME, never the overwriting
        // posix-rename extension. SFTPv3 requires failure if newpath exists;
        // LSTAT is only a collision optimization, not the overwrite guard.
        match sftp.rename(stage, &target).await {
            Ok(_) => return Ok(target),
            Err(error) => match sftp.lstat(&target).await {
                Ok(_) => continue, // Another writer claimed this candidate.
                Err(_) => return Err(sftp_error(format!("Atomic rename from private remote staging failed (possibly different filesystems): {error}"))),
            },
        }
    }
    Err(sftp_error(
        "No free upload name is available (1000 candidates already exist)",
    ))
}

// Only paths successfully created by this operation enter this manifest. No
// READDIR or recursive remote removal is ever used, including error recovery.
async fn cleanup_upload(
    sftp: &RawSftpSession,
    created: &[(String, bool)],
    error: SshError,
) -> SshError {
    use std::fmt::Write as _;
    let mut message = None;
    for (path, is_dir) in created.iter().rev() {
        let result = if *is_dir {
            sftp.rmdir(path).await
        } else {
            sftp.remove(path).await
        };
        if let Err(cleanup) = result {
            let message = message.get_or_insert_with(|| error.to_string());
            let _ = write!(
                message,
                "; failed to remove partial upload {path}: {cleanup}"
            );
        }
    }
    message.map(sftp_error).unwrap_or(error)
}

async fn upload_file(
    sftp: &RawSftpSession,
    local: File,
    remote: &str,
    created: &mut Vec<(String, bool)>,
    progress: &mut UploadProgress,
    on_progress: &(dyn Fn(UploadProgress) + Send + Sync),
) -> Result<u64, SshError> {
    let size = local.metadata()?.len();
    let mut local = tokio::fs::File::from_std(local);
    progress.phase = UploadPhase::Uploading;
    progress.transferred = 0;
    progress.total = Some(size);
    on_progress(progress.clone());
    let handle = sftp
        .open(
            remote,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            FileAttributes {
                permissions: Some(0o600),
                ..FileAttributes::default()
            },
        )
        .await
        .map_err(sftp_error)?
        .handle;
    created.push((remote.to_string(), false));
    let result = async {
        let mut last = Instant::now();
        loop {
            let mut buffer = vec![0; UPLOAD_CHUNK_BYTES];
            let read = local.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            if progress.transferred + read as u64 > size {
                return Err(sftp_error("Local file changed size during upload"));
            }
            buffer.truncate(read);
            sftp.write(&handle, progress.transferred, buffer)
                .await
                .map_err(sftp_error)?;
            progress.transferred += read as u64;
            if last.elapsed() >= Duration::from_millis(100) {
                on_progress(progress.clone());
                last = Instant::now();
            }
        }
        if progress.transferred != size {
            return Err(sftp_error("Local file changed size during upload"));
        }
        Ok(progress.transferred)
    }
    .await;
    let close = sftp.close(handle).await.map_err(sftp_error);
    on_progress(progress.clone());
    match (result, close) {
        (Ok(size), Ok(_)) => Ok(size),
        (Err(error), Ok(_)) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(close)) => Err(sftp_error(format!(
            "{error}; failed to close partial upload: {close}"
        ))),
    }
}

impl SshConnection {
    /// Backend-only sources obtained from the native picker. This method is not
    /// an IPC command: the webview can never supply local paths.
    pub async fn upload_paths_via_sftp(
        &self,
        remote_dir: &str,
        paths: Vec<PathBuf>,
        selection_kind: UploadSelectionKind,
        on_progress: &(dyn Fn(UploadProgress) + Send + Sync),
    ) -> Result<SftpUploadResult, SshError> {
        if paths.is_empty() || (selection_kind == UploadSelectionKind::Folder && paths.len() != 1) {
            return Err(sftp_error("Select files or one folder to upload"));
        }
        if remote_dir.is_empty() || remote_dir.contains('\0') {
            return Err(sftp_error("Invalid remote upload directory"));
        }
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = RawSftpSession::new(BoundedSftpStream::new(channel.into_stream()));
        let version = sftp.init().await.map_err(sftp_error)?;
        if version.version != 3 {
            return Err(sftp_error(
                "Uploads require non-overwriting SFTPv3 rename support",
            ));
        }
        let destination = sftp
            .realpath(remote_dir)
            .await
            .map_err(sftp_error)?
            .files
            .into_iter()
            .next()
            .ok_or_else(|| sftp_error("Remote directory could not be resolved"))?
            .filename;
        if !destination.starts_with('/')
            || destination.contains('\0')
            || !sftp
                .stat(&destination)
                .await
                .map_err(sftp_error)?
                .attrs
                .file_type()
                .is_dir()
        {
            return Err(sftp_error("Upload destination is not a remote directory"));
        }
        // Prefer a verified writable ancestor on the destination filesystem.
        // A sticky shared directory (such as /tmp) itself is safe; a non-sticky
        // shared directory may have a private parent on that same filesystem.
        // If no such parent exists, home staging can fail on cross-device
        // rename; never replace the atomic publish with an unsafe copy.
        let remote_os = self.detect_remote_os().await?;
        if remote_os != "linux" && remote_os != "macos" {
            return Err(sftp_error(
                "Cannot verify private staging on this SFTP server",
            ));
        }
        let (status, stdout, stderr) = self.exec_capture("id -u").await?;
        if status != Some(0) || !stderr.is_empty() {
            return Err(sftp_error("Cannot identify the remote staging owner"));
        }
        let remote_uid = stdout.parse::<u32>().map_err(sftp_error)?;
        let owner = (remote_os == "linux").then_some(remote_uid);
        if destination
            .split('/')
            .any(|part| part == "." || part == "..")
        {
            return Err(sftp_error("Invalid remote upload directory"));
        }
        let mut candidate = destination.as_str();
        let mut stage_parent = None;
        loop {
            let verified = match owner {
                Some(uid) => verify_linux_stage_parent(&sftp, candidate, uid, false)
                    .await
                    .is_ok(),
                None => verify_macos_stage_parent(self, candidate, false)
                    .await
                    .is_ok(),
            };
            if verified {
                if let Ok(attrs) = sftp.lstat(candidate).await.map(|reply| reply.attrs) {
                    if let (Some(uid), Some(mode)) = (attrs.uid, attrs.permissions) {
                        let user_writable = uid == remote_uid && mode & 0o300 == 0o300;
                        let sticky_shared = (uid == 0 || uid == remote_uid)
                            && mode & 0o1000 != 0
                            && mode & 0o003 == 0o003;
                        if user_writable || sticky_shared {
                            stage_parent = Some(candidate.to_owned());
                            break;
                        }
                    }
                }
            }
            if candidate == "/" {
                break;
            }
            candidate = match candidate.rsplit_once('/') {
                Some(("", _)) => "/",
                Some((parent, _)) => parent,
                None => break,
            };
        }
        let stage_parent = if let Some(parent) = stage_parent {
            parent
        } else {
            let home = sftp
                .realpath(".")
                .await
                .map_err(sftp_error)?
                .files
                .into_iter()
                .next()
                .ok_or_else(|| sftp_error("Remote staging parent could not be resolved"))?
                .filename;
            if !home.starts_with('/')
                || home.contains('\0')
                || home.split('/').any(|part| part == "." || part == "..")
            {
                return Err(sftp_error("Invalid remote staging parent"));
            }
            match owner {
                Some(uid) => verify_linux_stage_parent(&sftp, &home, uid, false).await?,
                None => verify_macos_stage_parent(self, &home, false).await?,
            }
            home
        };
        let mut result = SftpUploadResult::default();
        let mut progress = UploadProgress {
            phase: UploadPhase::Preparing,
            name: String::new(),
            transferred: 0,
            total: None,
            file_index: 0,
            file_count: if selection_kind == UploadSelectionKind::Files {
                paths.len()
            } else {
                0
            },
        };
        let mut last_preparing = None::<Instant>;
        for path in paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            progress.phase = UploadPhase::Preparing;
            progress.name = name.clone();
            progress.transferred = 0;
            progress.total = None;
            if selection_kind == UploadSelectionKind::Files {
                progress.file_index += 1;
            }
            if last_preparing.is_none_or(|at| at.elapsed() >= Duration::from_millis(100)) {
                on_progress(progress.clone());
                last_preparing = Some(Instant::now());
            }
            let prepared_name = name.clone();
            let preparation = tokio::task::spawn_blocking(move || -> io::Result<_> {
                validate_name(
                    path.file_name()
                        .ok_or_else(|| invalid_source("Select a named file or folder"))?,
                )?;
                let source = Arc::new(LocalSource::new(
                    &path,
                    selection_kind == UploadSelectionKind::Folder,
                )?);
                let entries = source.entries(&prepared_name)?;
                Ok((source, entries))
            })
            .await
            .map_err(sftp_error)?;
            let (source, entries) = match preparation {
                Ok(prepared) => prepared,
                Err(error) => {
                    result.failed.push(SftpUploadFailure {
                        name,
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            let is_dir = selection_kind == UploadSelectionKind::Folder;
            if is_dir {
                progress.file_count = entries.iter().filter(|entry| !entry.is_dir).count();
            }
            let stage_root = remote_child(
                &stage_parent,
                &format!(".redterm-upload-{}", uuid::Uuid::new_v4()),
            );
            let stage = remote_child(&stage_root, "payload");
            let mut created = Vec::new();
            let uploaded = async {
                // Until this exact directory is attested, do not add its name
                // to rollback: a hostile inherited ACL could let another user
                // populate it or swap the name even before the first write.
                sftp.mkdir(
                    &stage_root,
                    FileAttributes {
                        permissions: Some(0o700),
                        ..FileAttributes::default()
                    },
                )
                .await
                .map_err(sftp_error)?;
                match owner {
                    Some(uid) => verify_linux_stage_parent(&sftp, &stage_root, uid, true).await?,
                    None => verify_macos_stage_parent(self, &stage_root, true).await?,
                }
                created.push((stage_root.clone(), true));
                let mut size = 0;
                for entry in entries {
                    let remote = if entry.relative.as_os_str().is_empty() {
                        stage.clone()
                    } else {
                        remote_child(&stage, &entry.name[name.len() + 1..])
                    };
                    let source = Arc::clone(&source);
                    let local = tokio::task::spawn_blocking(move || source.open(&entry.relative))
                        .await
                        .map_err(sftp_error)??;
                    if validate_type(&local)? != entry.is_dir {
                        return Err(sftp_error(format!(
                            "Local source changed type: {}",
                            entry.name
                        )));
                    }
                    if entry.is_dir {
                        sftp.mkdir(
                            &remote,
                            FileAttributes {
                                permissions: Some(0o700),
                                ..FileAttributes::default()
                            },
                        )
                        .await
                        .map_err(sftp_error)?;
                        created.push((remote, true));
                    } else {
                        if is_dir {
                            progress.file_index += 1;
                        }
                        progress.name = entry.name;
                        size += upload_file(
                            &sftp,
                            local.file,
                            &remote,
                            &mut created,
                            &mut progress,
                            on_progress,
                        )
                        .await?;
                    }
                }
                progress.phase = UploadPhase::Finishing;
                on_progress(progress.clone());
                let remote_path = commit_upload(&sftp, &stage, &destination, &name).await?;
                Ok::<_, SshError>(SftpUploadedItem {
                    name: name.clone(),
                    remote_path,
                    size,
                    is_dir,
                })
            }
            .await;
            last_preparing = None;
            match uploaded {
                Ok(item) => {
                    result.uploaded.push(item);
                    // The child was moved, leaving only our private container.
                    // Never undo the published destination in a shared parent.
                    if let Err(error) = sftp.rmdir(&stage_root).await {
                        result.failed.push(SftpUploadFailure {
                            name,
                            error: format!(
                                "Uploaded, but could not remove private staging directory: {error}"
                            ),
                        });
                    }
                }
                Err(error) => result.failed.push(SftpUploadFailure {
                    name,
                    error: cleanup_upload(&sftp, &created, error).await.to_string(),
                }),
            }
        }
        progress.phase = UploadPhase::Finishing;
        on_progress(progress);
        Ok(result)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::fs::symlink;

    #[test]
    fn remote_stage_requires_owner_and_replacement_protection() {
        let owner = 501;
        assert!(safe_stage_component(owner, owner, 0o755, false));
        assert!(safe_stage_component(0, owner, 0o1777, false)); // /tmp
        assert!(!safe_stage_component(owner, owner, 0o777, false));
        assert!(!safe_stage_component(502, owner, 0o1777, false));
        assert!(safe_stage_component(owner, owner, 0o700, true));
        assert!(!safe_stage_component(owner, owner, 0o755, true));
        assert!(!safe_stage_component(0, owner, 0o700, true));
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("redterm-upload-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn upload_source_rejects_symlinks_and_special_files() {
        let fixture = Fixture::new();
        let root = fixture.0.join("selected");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(fixture.0.join("outside"), b"not selected").unwrap();
        symlink(fixture.0.join("outside"), root.join("link")).unwrap();
        assert!(LocalSource::new(&root.join("link"), false).is_err());
        assert!(LocalSource::new(&root, true)
            .unwrap()
            .entries("selected")
            .is_err());
        std::fs::remove_file(root.join("link")).unwrap();
        let fifo =
            std::ffi::CString::new(root.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(LocalSource::new(&root, true)
            .unwrap()
            .entries("selected")
            .is_err());
    }

    #[test]
    fn upload_source_pins_selected_root_and_rejects_descendant_link_swaps() {
        let fixture = Fixture::new();
        let root = fixture.0.join("selected");
        let outside = fixture.0.join("outside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(outside.join("sub")).unwrap();
        std::fs::write(root.join("sub/file"), b"selected bytes").unwrap();
        std::fs::write(outside.join("sub/file"), b"private bytes").unwrap();
        let source = LocalSource::new(&root, true).unwrap();
        source.entries("selected").unwrap();
        let moved = fixture.0.join("moved");
        std::fs::rename(&root, &moved).unwrap();
        symlink(&outside, &root).unwrap();
        let mut bytes = String::new();
        source
            .open(Path::new("sub/file"))
            .unwrap()
            .file
            .read_to_string(&mut bytes)
            .unwrap();
        assert_eq!(bytes, "selected bytes");
        std::fs::remove_file(moved.join("sub/file")).unwrap();
        symlink(outside.join("sub/file"), moved.join("sub/file")).unwrap();
        assert!(source.open(Path::new("sub/file")).is_err());
        std::fs::remove_file(moved.join("sub/file")).unwrap();
        std::fs::remove_dir(moved.join("sub")).unwrap();
        symlink(outside.join("sub"), moved.join("sub")).unwrap();
        assert!(source.open(Path::new("sub/file")).is_err());
        assert!(source.open(Path::new("../outside/sub/file")).is_err());
    }
    #[test]
    fn upload_source_rejects_substituted_ancestor_before_opening_selected_file() {
        let fixture = Fixture::new();
        let selected = fixture.0.join("selected");
        let private = fixture.0.join("private");
        std::fs::create_dir_all(selected.join("nested")).unwrap();
        std::fs::create_dir_all(private.join("nested")).unwrap();
        std::fs::write(selected.join("nested/file"), b"selected bytes").unwrap();
        std::fs::write(private.join("nested/file"), b"private bytes").unwrap();
        let picked = selected.join("nested/file");
        std::fs::rename(&selected, fixture.0.join("moved")).unwrap();
        symlink(&private, &selected).unwrap();
        assert!(LocalSource::new(&picked, false).is_err());
    }

    #[test]
    fn upload_source_accepts_nested_folder_and_pins_swapped_ancestor() {
        let fixture = Fixture::new();
        let selected = fixture.0.join("selected");
        let private = fixture.0.join("private");
        std::fs::create_dir_all(selected.join("nested/deeper")).unwrap();
        std::fs::create_dir_all(private.join("nested/deeper")).unwrap();
        std::fs::write(selected.join("nested/deeper/file"), b"selected bytes").unwrap();
        std::fs::write(private.join("nested/deeper/file"), b"private bytes").unwrap();
        let source = LocalSource::new(&selected.join("nested"), true).unwrap();
        assert_eq!(source.entries("nested").unwrap().len(), 3);
        std::fs::rename(&selected, fixture.0.join("moved")).unwrap();
        symlink(&private, &selected).unwrap();
        let mut bytes = String::new();
        source
            .open(Path::new("deeper/file"))
            .unwrap()
            .file
            .read_to_string(&mut bytes)
            .unwrap();
        assert_eq!(bytes, "selected bytes");
    }

    #[test]
    fn upload_source_rejects_relative_and_absolute_parent_escapes() {
        let fixture = Fixture::new();
        std::fs::create_dir(fixture.0.join("selected")).unwrap();
        std::fs::write(fixture.0.join("private"), b"private bytes").unwrap();
        assert_eq!(
            LocalSource::new(Path::new("../private"), false)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            LocalSource::new(&fixture.0.join("selected/../private"), false)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn openssh_upload_uses_private_stage_for_shared_acl_and_safe_rollback() {
        use crate::ssh::{AuthConfig, AuthMethod};
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Child, Command, Stdio};

        struct Server(Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let fixture = Fixture::new();
        let root = &fixture.0;
        let key = root.join("client_key");
        let host_key = root.join("host_key");
        for path in [&key, &host_key] {
            assert!(Command::new("/usr/bin/ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(path)
                .status()
                .unwrap()
                .success());
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
        fs::write(
            &config,
            format!(
                "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nSubsystem sftp internal-sftp\nPidFile {}\nLogLevel ERROR\n",
                host_key.display(),
                root.join("authorized_keys").display(),
                root.join("sshd.pid").display()
            ),
        )
        .unwrap();
        let mut server = Server(
            Command::new("/usr/sbin/sshd")
                .args(["-D", "-e", "-f"])
                .arg(&config)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut ready = false;
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            assert!(
                server.0.try_wait().unwrap().is_none(),
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
        .unwrap();

        // /tmp is writable by other accounts but sticky: stage there on the
        // destination filesystem; preserve an existing file on name collision.
        let filename = format!("redterm-shared-{}.bin", uuid::Uuid::new_v4());
        let source = root.join(&filename);
        fs::write(&source, b"private upload bytes").unwrap();
        let collision = Path::new("/tmp").join(&filename);
        fs::write(&collision, b"existing destination bytes").unwrap();
        let phases = std::sync::Mutex::new(Vec::new());
        let shared_result = connection
            .upload_paths_via_sftp(
                "/tmp",
                vec![source.clone()],
                UploadSelectionKind::Files,
                &|progress| {
                    phases
                        .lock()
                        .unwrap()
                        .push((progress.phase, progress.transferred));
                },
            )
            .await
            .unwrap();
        assert!(
            shared_result.failed.is_empty(),
            "{:?}",
            shared_result.failed
        );
        assert_eq!(shared_result.uploaded.len(), 1);
        let progress = phases.lock().unwrap();
        assert!(progress.contains(&(UploadPhase::Uploading, b"private upload bytes".len() as u64)));
        assert!(progress
            .iter()
            .any(|(phase, _)| *phase == UploadPhase::Finishing));
        drop(progress);
        assert_eq!(fs::read(&collision).unwrap(), b"existing destination bytes");
        assert_eq!(
            fs::read(&shared_result.uploaded[0].remote_path).unwrap(),
            b"private upload bytes"
        );
        fs::remove_file(&collision).unwrap();
        fs::remove_file(&shared_result.uploaded[0].remote_path).unwrap();

        let shared = root.join("acl-shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(Command::new("/bin/chmod")
            .args(["+a", "everyone allow read,file_inherit,directory_inherit"])
            .arg(&shared)
            .status()
            .unwrap()
            .success());
        let sentinel = root.join("unrelated-sentinel");
        fs::write(&sentinel, b"must survive rollback").unwrap();
        let trap = shared.join(".redterm-upload-adversary");
        symlink(&sentinel, &trap).unwrap();
        let ok = connection
            .upload_paths_via_sftp(
                shared.to_str().unwrap(),
                vec![source.clone()],
                UploadSelectionKind::Files,
                &|progress| {
                    if progress.phase == UploadPhase::Uploading {
                        assert_eq!(fs::read_dir(&shared).unwrap().count(), 1);
                    }
                },
            )
            .await
            .unwrap();
        assert!(ok.failed.is_empty(), "{:?}", ok.failed);
        assert_eq!(
            fs::read(&ok.uploaded[0].remote_path).unwrap(),
            b"private upload bytes"
        );
        assert_eq!(
            fs::metadata(&ok.uploaded[0].remote_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_file(&ok.uploaded[0].remote_path).unwrap();

        let folder = root.join("selected-folder");
        fs::create_dir(&folder).unwrap();
        fs::create_dir(folder.join("nested")).unwrap();
        fs::write(folder.join("nested/document.txt"), b"nested upload bytes").unwrap();
        let folder_upload = connection
            .upload_paths_via_sftp(
                shared.to_str().unwrap(),
                vec![folder],
                UploadSelectionKind::Folder,
                &|_| {},
            )
            .await
            .unwrap();
        assert!(
            folder_upload.failed.is_empty(),
            "{:?}",
            folder_upload.failed
        );
        assert_eq!(folder_upload.uploaded.len(), 1);
        assert!(folder_upload.uploaded[0].is_dir);
        assert_eq!(
            fs::read(Path::new(&folder_upload.uploaded[0].remote_path).join("nested/document.txt"))
                .unwrap(),
            b"nested upload bytes"
        );
        fs::remove_dir_all(&folder_upload.uploaded[0].remote_path).unwrap();
        let failed = connection
            .upload_paths_via_sftp(
                shared.to_str().unwrap(),
                vec![source],
                UploadSelectionKind::Files,
                &|progress| {
                    if progress.phase == UploadPhase::Uploading {
                        fs::set_permissions(&shared, fs::Permissions::from_mode(0o555)).unwrap();
                    }
                },
            )
            .await
            .unwrap();
        assert_eq!(failed.uploaded.len(), 0);
        assert_eq!(failed.failed.len(), 1);
        assert!(
            failed.failed[0].error.contains("Atomic rename"),
            "{:?}",
            failed.failed
        );
        assert_eq!(fs::read(&sentinel).unwrap(), b"must survive rollback");
        assert!(fs::symlink_metadata(&trap)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(fs::read_dir(&shared).unwrap().count(), 1);
        assert!(!fs::read_dir(root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".redterm-upload-")
        }));
    }
}

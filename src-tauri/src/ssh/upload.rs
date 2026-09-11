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

use super::{SshConnection, SshError};
use crate::storage::unique_destination_names;

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
fn open_local(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    validate_type(&file)?;
    Ok(file)
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
        let (path, ancestors) = {
            let name = path
                .file_name()
                .ok_or_else(|| invalid_source("Select a named file or folder"))?;
            let path = std::fs::canonicalize(path.parent().unwrap_or(Path::new(".")))?.join(name);
            let mut parents = path.ancestors().skip(1).collect::<Vec<_>>();
            parents.reverse();
            let mut handles = Vec::with_capacity(parents.len());
            for parent in parents {
                handles.push(open_local(parent)?);
            }
            (path, handles)
        };
        let root = open_local(path.as_ref())?;
        if validate_type(&root)? != folder {
            return Err(invalid_source(if folder {
                "Select a regular folder"
            } else {
                "Select regular files"
            }));
        }
        Ok(Self {
            root,
            #[cfg(windows)]
            path,
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
                use std::os::fd::{AsRawFd, FromRawFd};
                let name = std::ffi::CString::new(name.as_encoded_bytes())
                    .map_err(|_| invalid_source("Invalid upload file name"))?;
                let fd = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                file = unsafe { File::from_raw_fd(fd) };
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
        let mut pending = vec![(PathBuf::new(), name.to_string())];
        while let Some((relative, name)) = pending.pop() {
            let file = self.open(&relative)?;
            let is_dir = validate_type(&file)?;
            if is_dir {
                #[cfg(unix)]
                let names = directory_names(&file)?;
                #[cfg(windows)]
                let names = std::fs::read_dir(self.path.join(&relative))?
                    .map(|entry| entry.map(|entry| entry.file_name()))
                    .collect::<io::Result<Vec<_>>>()?;
                for child in names {
                    let child_name = validate_name(&child)?;
                    pending.push((relative.join(&child), format!("{name}/{child_name}")));
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
fn directory_names(file: &File) -> io::Result<Vec<OsString>> {
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
                Err(_) => return Err(sftp_error(error)),
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
        let sftp = RawSftpSession::new(channel.into_stream());
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
            let stage = remote_child(
                &destination,
                &format!(".redterm-upload-{}", uuid::Uuid::new_v4()),
            );
            let mut created = Vec::new();
            let uploaded = async {
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
                Ok(item) => result.uploaded.push(item),
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

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("redterm-upload-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
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
}

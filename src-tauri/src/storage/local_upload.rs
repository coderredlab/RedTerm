use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::ssh::upload::{
    validate_name, validate_type, LocalFile, LocalSource, SftpUploadFailure, SftpUploadedItem,
    UploadPhase,
};
use crate::ssh::{SftpUploadResult, UploadProgress, UploadSelectionKind};

use super::unique_destination_names;

const COPY_CHUNK_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity(u64, u64);

#[cfg(unix)]
fn identity(file: &File) -> io::Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(Identity(metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn identity(file: &File) -> io::Result<Identity> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(io::Error::other)?;
    Ok(Identity(
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}

struct Created {
    relative: PathBuf,
    identity: Identity,
    is_dir: bool,
}

/// Handles are held only for the destination root and the active traversal.
/// The rollback manifest stores identities, not one descriptor per entry.
struct Destination {
    root: LocalSource,
    #[cfg(windows)]
    path: PathBuf,
    directories: HashMap<PathBuf, Identity>,
    created: Vec<Created>,
}

impl Destination {
    fn new(path: &Path) -> io::Result<Self> {
        Ok(Self {
            root: LocalSource::new(path, true)?,
            #[cfg(windows)]
            path: std::fs::canonicalize(path)?,
            directories: HashMap::new(),
            created: Vec::new(),
        })
    }

    fn parent(&self, relative: &Path) -> io::Result<LocalFile> {
        let parent = relative.parent().unwrap_or(Path::new(""));
        let file = self.root.open(parent)?;
        if !parent.as_os_str().is_empty() && self.directories.get(parent) != Some(&identity(&file)?)
        {
            return Err(io::Error::other("Copy destination folder was replaced"));
        }
        Ok(file)
    }

    fn create(&mut self, relative: &Path, is_dir: bool) -> io::Result<File> {
        let name = validate_name(relative.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Invalid copy destination name")
        })?)?;
        #[cfg(windows)]
        if name.contains(':') || name.ends_with(['.', ' ']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Unsupported Windows copy destination name",
            ));
        }
        let parent = self.parent(relative)?;
        #[cfg(unix)]
        let file = create_at(&parent, name, is_dir)?;
        #[cfg(windows)]
        let file = create_at(&self.path.join(relative), is_dir)?;
        let identity = identity(&file).map_err(|error| {
            io::Error::other(format!(
                "Created {}, but could not identify it; partial entry retained: {error}",
                relative.display()
            ))
        })?;
        if is_dir {
            self.directories.insert(relative.to_path_buf(), identity);
        }
        self.created.push(Created {
            relative: relative.to_path_buf(),
            identity,
            is_dir,
        });
        // Keep the Windows parent deny-delete handles alive through creation.
        drop(parent);
        Ok(file)
    }

    fn claim(&mut self, name: &str, is_dir: bool) -> io::Result<(PathBuf, File)> {
        for candidate in unique_destination_names(name) {
            let relative = PathBuf::from(candidate);
            match self.create(&relative, is_dir) {
                Ok(file) => return Ok((relative, file)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::other(
            "Could not find a free copy destination name",
        ))
    }

    fn rollback(&self, error: io::Error) -> String {
        let mut message = error.to_string();
        for entry in self.created.iter().rev() {
            let removed = (|| {
                let parent = self.parent(&entry.relative)?;
                #[cfg(unix)]
                let result = remove_at(&parent, entry);
                #[cfg(windows)]
                let result = remove_at(&self.path.join(&entry.relative), entry);
                drop(parent);
                result
            })();
            if let Err(cleanup) = removed {
                if cleanup.kind() != io::ErrorKind::NotFound {
                    message.push_str(&format!(
                        "; failed to remove partial copy {}: {cleanup}",
                        entry.relative.display()
                    ));
                }
            }
        }
        message
    }
}

#[cfg(unix)]
fn create_at(parent: &File, name: &str, is_dir: bool) -> io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name)?;
    if is_dir && unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let flags = if is_dir {
        libc::O_RDONLY | libc::O_DIRECTORY
    } else {
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL
    };
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return Err(if is_dir {
            io::Error::other(format!(
                "Created folder, but could not pin it; partial folder retained: {error}"
            ))
        } else {
            error
        });
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn remove_at(parent: &File, entry: &Created) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let name = std::ffi::CString::new(entry.relative.file_name().unwrap().as_encoded_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    if Identity(stat.st_dev as u64, stat.st_ino as u64) != entry.identity {
        return Err(io::Error::other(
            "Copy destination entry was replaced; retained",
        ));
    }
    // Never recurse: an unrecognized child makes rmdir fail and is preserved.
    let flags = if entry.is_dir { libc::AT_REMOVEDIR } else { 0 };
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn create_at(path: &Path, is_dir: bool) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    if is_dir {
        std::fs::create_dir(path)?;
    }
    let result = std::fs::OpenOptions::new()
        .read(true)
        .write(!is_dir)
        .create_new(!is_dir)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .and_then(|file| {
            if validate_type(&file)? != is_dir {
                return Err(io::Error::other("Copy destination changed type"));
            }
            Ok(file)
        });
    result.map_err(|error| {
        if is_dir {
            io::Error::other(format!(
                "Created folder, but could not pin it; partial folder retained: {error}"
            ))
        } else {
            error
        }
    })
}

#[cfg(windows)]
fn remove_at(path: &Path, entry: &Created) -> io::Result<()> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::Foundation::{GENERIC_READ, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, DELETE, FILE_DISPOSITION_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    let file = std::fs::OpenOptions::new()
        .access_mode(GENERIC_READ.0 | DELETE.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    if identity(&file)? != entry.identity || validate_type(&file)? != entry.is_dir {
        return Err(io::Error::other(
            "Copy destination entry was replaced; retained",
        ));
    }
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            std::ptr::from_ref(&info).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    }
    .map_err(io::Error::other)
}

fn copy_file(
    mut source: &File,
    mut destination: File,
    progress: &mut UploadProgress,
    on_progress: &(dyn Fn(UploadProgress) + Send + Sync),
) -> io::Result<u64> {
    let size = source.metadata()?.len();
    progress.phase = UploadPhase::Uploading;
    progress.transferred = 0;
    progress.total = Some(size);
    on_progress(progress.clone());
    let mut buffer = [0; COPY_CHUNK_BYTES];
    let mut last = Instant::now();
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if read as u64 > size.saturating_sub(progress.transferred) {
            return Err(io::Error::other("Local file changed size during copy"));
        }
        destination.write_all(&buffer[..read])?;
        progress.transferred += read as u64;
        if last.elapsed() >= Duration::from_millis(100) {
            on_progress(progress.clone());
            last = Instant::now();
        }
    }
    if progress.transferred != size || source.metadata()?.len() != size {
        return Err(io::Error::other("Local file changed size during copy"));
    }
    destination.sync_all()?;
    on_progress(progress.clone());
    Ok(size)
}

/// Backend-only native picker paths. A complete source scan precedes creation,
/// so copying a folder into itself cannot discover and recurse into its output.
pub(crate) fn copy_upload_paths(
    destination: &Path,
    paths: Vec<PathBuf>,
    kind: UploadSelectionKind,
    on_progress: &(dyn Fn(UploadProgress) + Send + Sync),
) -> Result<SftpUploadResult, String> {
    let is_dir = kind == UploadSelectionKind::Folder;
    if paths.is_empty() || (is_dir && paths.len() != 1) {
        return Err("Select files or one folder to copy".to_string());
    }
    let mut target = Destination::new(destination)
        .map_err(|error| format!("Failed to open copy destination: {error}"))?;
    let mut result = SftpUploadResult::default();
    let mut progress = UploadProgress {
        phase: UploadPhase::Preparing,
        name: String::new(),
        transferred: 0,
        total: None,
        file_index: 0,
        file_count: if is_dir { 0 } else { paths.len() },
    };
    for path in paths {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        progress.phase = UploadPhase::Preparing;
        progress.name = name.clone();
        progress.transferred = 0;
        progress.total = None;
        if !is_dir {
            progress.file_index += 1;
        }
        on_progress(progress.clone());
        let copied = (|| -> io::Result<_> {
            validate_name(path.file_name().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "Select a named file or folder")
            })?)?;
            // Prepare, transfer, release this selection before opening the next.
            let source = LocalSource::new(&path, is_dir)?;
            let entries = source.entries(&name)?;
            if is_dir {
                progress.file_count = entries.iter().filter(|entry| !entry.is_dir).count();
            }
            let (root, root_file) = target.claim(&name, is_dir)?;
            let mut root_file = Some(root_file);
            let mut size = 0;
            for entry in entries {
                let local = source.open(&entry.relative)?;
                if validate_type(&local)? != entry.is_dir {
                    return Err(io::Error::other(format!(
                        "Local source changed type: {}",
                        entry.name
                    )));
                }
                let file = if entry.relative.as_os_str().is_empty() {
                    root_file.take().unwrap()
                } else {
                    target.create(&root.join(&entry.relative), entry.is_dir)?
                };
                if !entry.is_dir {
                    if is_dir {
                        progress.file_index += 1;
                    }
                    progress.name = entry.name;
                    size += copy_file(&local, file, &mut progress, on_progress)?;
                }
            }
            progress.phase = UploadPhase::Finishing;
            on_progress(progress.clone());
            Ok(SftpUploadedItem {
                name: name.clone(),
                remote_path: destination.join(root).to_string_lossy().into_owned(),
                size,
                is_dir,
            })
        })();
        match copied {
            Ok(item) => result.uploaded.push(item),
            Err(error) => result.failed.push(SftpUploadFailure {
                name,
                error: target.rollback(error),
            }),
        }
        // A later selection failure must never remove completed copies.
        target.created.clear();
        target.directories.clear();
    }
    progress.phase = UploadPhase::Finishing;
    on_progress(progress);
    Ok(result)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::os::unix::fs::symlink;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("redterm-local-copy-test-{}", uuid::Uuid::new_v4()));
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
    fn many_files_preserve_collisions_and_independent_successes() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        let destination = fixture.0.join("destination");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination).unwrap();
        let mut paths = Vec::new();
        for index in 0..300 {
            let path = source.join(format!("파일-{index}.txt"));
            std::fs::write(&path, format!("contents-{index}")).unwrap();
            paths.push(path);
        }
        std::fs::write(destination.join("파일-0.txt"), b"existing").unwrap();
        symlink("missing-target", destination.join("파일-1.txt")).unwrap();
        paths.insert(1, source.join("missing"));
        let events = Mutex::new(Vec::new());
        let result = copy_upload_paths(&destination, paths, UploadSelectionKind::Files, &|event| {
            events.lock().push(event);
        })
        .unwrap();
        assert_eq!(result.uploaded.len(), 300);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].name, "missing");
        assert_eq!(
            std::fs::read(destination.join("파일-0.txt")).unwrap(),
            b"existing"
        );
        assert_eq!(
            std::fs::read_link(destination.join("파일-1.txt")).unwrap(),
            Path::new("missing-target")
        );
        for (index, item) in result.uploaded.iter().enumerate() {
            assert_eq!(
                std::fs::read(&item.remote_path).unwrap(),
                format!("contents-{index}").as_bytes()
            );
        }
        let events = events.into_inner();
        assert!(events.iter().all(|event| event.file_count == 301));
        assert_eq!(events.last().unwrap().file_index, 301);
        assert!(events
            .iter()
            .any(|event| event.phase == UploadPhase::Preparing && event.name == "missing"));
    }

    #[test]
    fn folder_copy_snapshots_self_descendants_and_never_merges() {
        let fixture = Fixture::new();
        let source = fixture.0.join("tree");
        std::fs::create_dir_all(source.join("nested/empty")).unwrap();
        std::fs::write(source.join("nested/영.txt"), b"").unwrap();
        let payload: Vec<u8> = (0..98_311).map(|index| (index % 251) as u8).collect();
        std::fs::write(source.join("data"), &payload).unwrap();
        let events = Mutex::new(Vec::new());
        let result = copy_upload_paths(
            &source.join("nested"),
            vec![source.clone()],
            UploadSelectionKind::Folder,
            &|event| {
                events.lock().push(event);
            },
        )
        .unwrap();
        assert!(result.failed.is_empty(), "{:?}", result.failed);
        assert_eq!(result.uploaded[0].size, payload.len() as u64);
        let copied = source.join("nested/tree");
        assert!(copied.join("nested/empty").is_dir());
        assert_eq!(std::fs::read(copied.join("nested/영.txt")).unwrap(), b"");
        assert_eq!(std::fs::read(copied.join("data")).unwrap(), payload);
        assert!(!copied.join("nested/tree").exists());
        let events = events.into_inner();
        assert_eq!(events.last().unwrap().file_count, 2);
        assert_eq!(events.last().unwrap().file_index, 2);

        let destination = fixture.0.join("destination");
        std::fs::create_dir_all(destination.join("empty")).unwrap();
        std::fs::write(destination.join("empty/keep"), b"untouched").unwrap();
        let result = copy_upload_paths(
            &destination,
            vec![source.join("nested/empty")],
            UploadSelectionKind::Folder,
            &|_| {},
        )
        .unwrap();
        assert!(result.failed.is_empty(), "{:?}", result.failed);
        assert_eq!(
            Path::new(&result.uploaded[0].remote_path),
            destination.join("empty (1)")
        );
        assert_eq!(
            std::fs::read(destination.join("empty/keep")).unwrap(),
            b"untouched"
        );
        assert_eq!(
            std::fs::read_dir(destination.join("empty (1)"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn source_size_change_rolls_back_only_its_manifest() {
        let fixture = Fixture::new();
        let source = fixture.0.join("tree");
        let destination = fixture.0.join("destination");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(source.join("data"), b"original bytes").unwrap();
        let result = copy_upload_paths(
            &destination,
            vec![source.clone()],
            UploadSelectionKind::Folder,
            &|event| {
                if event.phase == UploadPhase::Uploading && event.transferred == 0 {
                    std::fs::write(source.join("data"), b"").unwrap();
                    std::fs::write(destination.join("tree/unknown"), b"keep me").unwrap();
                }
            },
        )
        .unwrap();
        assert!(result.uploaded.is_empty());
        assert_eq!(result.failed.len(), 1);

        assert!(result.failed[0]
            .error
            .contains(source.file_name().unwrap().to_str().unwrap()));
        assert!(!destination.join("tree/data").exists());
        assert_eq!(
            std::fs::read(destination.join("tree/unknown")).unwrap(),
            b"keep me"
        );
    }

    #[test]
    fn destination_repoint_does_not_redirect_copy_or_rollback() {
        let fixture = Fixture::new();
        let destination = fixture.0.join("destination");
        let moved = fixture.0.join("moved");
        let outside = fixture.0.join("outside");
        let source = fixture.0.join("data");
        std::fs::create_dir(&destination).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(&source, b"selected bytes").unwrap();
        std::fs::write(outside.join("data"), b"private bytes").unwrap();
        let result = copy_upload_paths(
            &destination,
            vec![source.clone()],
            UploadSelectionKind::Files,
            &|event| {
                if event.phase == UploadPhase::Uploading && event.transferred == 0 {
                    std::fs::rename(&destination, &moved).unwrap();
                    symlink(&outside, &destination).unwrap();
                    std::fs::write(&source, b"size changed").unwrap();
                }
            },
        )
        .unwrap();
        assert_eq!(result.failed.len(), 1);
        assert!(result.uploaded.is_empty());
        assert!(!moved.join("data").exists());
        assert_eq!(
            std::fs::read(outside.join("data")).unwrap(),
            b"private bytes"
        );
    }
}

use super::{SshConnection, SshError};

pub(super) fn safe_stage_component(uid: u32, owner: u32, mode: u32, stage: bool) -> bool {
    (uid == owner || uid == 0)
        && (mode & 0o022 == 0 || mode & 0o1000 != 0)
        && (!stage || (uid == owner && mode & 0o7777 == 0o700))
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
        return Err(SshError::SessionError(format!(
            "Cannot verify private remote staging directory: {stderr}"
        )));
    }
    Ok(())
}

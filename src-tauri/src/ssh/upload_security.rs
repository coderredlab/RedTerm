use super::{SshConnection, SshError};

pub(super) fn safe_stage_component(uid: u32, owner: u32, mode: u32, stage: bool) -> bool {
    (uid == owner || uid == 0)
        && (mode & 0o022 == 0 || mode & 0o1000 != 0)
        && (!stage || (uid == owner && mode & 0o7777 == 0o700))
}

// macOS ACLs are not exposed by SFTPv3. Traverse through O_NOFOLLOW
// descriptors and check each ACL before creating any payload.
const MACOS_STAGE_VERIFY_SCRIPT: &str = r#"
import ctypes, errno, os, stat, sys
path, stage = sys.argv[1], sys.argv[2] == '1'
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
libc.acl_get_fd.argtypes = [ctypes.c_int]
libc.acl_get_fd.restype = ctypes.c_void_p
libc.acl_free.argtypes = [ctypes.c_void_p]
libc.acl_free.restype = ctypes.c_int
libc.acl_to_text.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)]
libc.acl_to_text.restype = ctypes.c_void_p
if not path.startswith('/') or '\x00' in path or any(p in ('.', '..') for p in path.split('/')):
    raise ValueError('invalid staging path')
components = [''] + [p for p in path.split('/') if p]
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    for index, component in enumerate(components):
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
            try:
                if stage and index == len(components) - 1:
                    raise ValueError('staging directory has an ACL')
                length = ctypes.c_ssize_t()
                text = libc.acl_to_text(acl, ctypes.byref(length))
                if not text:
                    raise ValueError('cannot inspect staging ancestor ACL')
                try:
                    lines = ctypes.string_at(text, length.value).decode('utf-8').splitlines()
                finally:
                    libc.acl_free(text)
                read_only = {'read', 'list', 'search', 'execute', 'readattr',
                             'readextattr', 'readsecurity', 'file_inherit',
                             'directory_inherit'}
                if not lines or not lines[0].startswith('!#acl '):
                    raise ValueError('unrecognized staging ancestor ACL')
                for line in lines[1:]:
                    parts = line.rsplit(':', 2)
                    if len(parts) != 3:
                        raise ValueError('unrecognized staging ancestor ACL')
                    policy, permissions = parts[1:]
                    if policy.split(',')[0] != 'deny' and not (
                            policy.split(',')[0] == 'allow' and
                            all(p in read_only for p in permissions.split(','))):
                        raise ValueError('staging ancestor has an unsafe ACL')
            finally:
                libc.acl_free(acl)
        elif ctypes.get_errno() != errno.ENOENT:
            raise ValueError('cannot verify staging ancestor ACL')
    if stage and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError('staging directory is not owned and private')
    print('PRIVATE')
finally:
    os.close(fd)
"#;

pub(super) async fn verify_macos_stage_parent(
    connection: &SshConnection,
    path: &str,
    stage: bool,
) -> Result<(), SshError> {
    let script = MACOS_STAGE_VERIFY_SCRIPT;
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::MACOS_STAGE_VERIFY_SCRIPT;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Output};

    fn verify(path: &std::path::Path, stage: bool) -> Output {
        Command::new("/usr/bin/python3")
            .args([
                "-c",
                MACOS_STAGE_VERIFY_SCRIPT,
                path.to_str().unwrap(),
                if stage { "1" } else { "0" },
            ])
            .output()
            .unwrap()
    }

    fn add_acl(path: &std::path::Path, entry: &str) {
        assert!(Command::new("/bin/chmod")
            .args(["+a", entry])
            .arg(path)
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn stage_allows_harmless_ancestor_acls_but_never_an_acl_on_the_stage() {
        let base = std::env::temp_dir().join(format!("redterm-stage-acl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let base = std::fs::canonicalize(base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let stage = base.join("stage");
        std::fs::create_dir(&stage).unwrap();
        std::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o700)).unwrap();

        add_acl(&base, "everyone deny delete");
        add_acl(&base, "everyone allow read,list,search");
        let allowed = verify(&stage, true);
        assert!(
            allowed.status.success(),
            "safe ancestor ACLs rejected: {}",
            String::from_utf8_lossy(&allowed.stderr)
        );
        assert_eq!(allowed.stdout, b"PRIVATE\n");

        add_acl(&stage, "everyone allow read");
        let unsafe_stage = verify(&stage, true);
        assert!(!unsafe_stage.status.success());
        assert!(
            String::from_utf8_lossy(&unsafe_stage.stderr).contains("staging directory has an ACL")
        );

        add_acl(&base, "everyone allow delete_child,add_file");
        let unsafe_ancestor = verify(&base, false);
        assert!(!unsafe_ancestor.status.success());
        assert!(String::from_utf8_lossy(&unsafe_ancestor.stderr)
            .contains("staging ancestor has an unsafe ACL"));
        for path in [&stage, &base] {
            assert!(Command::new("/bin/chmod")
                .arg("-N")
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}

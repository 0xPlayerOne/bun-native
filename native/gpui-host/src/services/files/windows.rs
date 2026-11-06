//! Windows: no `openat2` and no `O_NOFOLLOW`, so, as on macOS, the path is
//! walked one validated name at a time. Each step is `NtCreateFile` with the
//! previous step's handle as `RootDirectory` and a single name, starting at
//! the grant's directory handle (see `bun_native_windows_services::fs`):
//!
//! - Every step opens with `FILE_OPEN_REPARSE_POINT` and `OBJ_DONT_REPARSE`,
//!   so a symbolic link, junction or mount point is opened as itself, never
//!   followed, and is then refused like a Linux link (`path_denied`).
//!   Intermediate steps also require a directory.
//! - Names Windows would read as more than one plain entry are refused before
//!   any system call: `\`, `:` (drives and alternate data streams), the other
//!   reserved characters, trailing dots and spaces, and DOS device names such
//!   as `CON`, `NUL` or `COM1.txt`.
//! - As defence in depth, the opened entry's normalized final path must be
//!   the grant root's followed by exactly the requested names (compared
//!   without case, as the volume resolves them). This refuses an 8.3 short
//!   name such as `SECRET~1.TXT`, which would otherwise reach the long name
//!   by a second spelling, and anything that resolved outside the root.
//!
//! As with the other backends, a directory renamed out of the grant while a
//! walk holds its handle stays the directory that was opened; no path text
//! is resolved again. Names resolve as the volume does, so a
//! case-insensitive NTFS directory matches `A.TXT` to `a.txt`.

use super::{Failure, MAX_SCANNED_ENTRIES};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bun_native_protocol::{
    DirectoryEntry, ErrorCode, FileKind, FileOperation, FileResult, MAX_DIRECTORY_ENTRIES,
    MAX_FILE_OFFSET, WriteMode, validate_file_name,
};
use bun_native_windows_services::fs::{
    self, Access, Create, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_DIR_NOT_EMPTY,
    ERROR_DIRECTORY, ERROR_DISK_FULL, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND,
    ERROR_FILENAME_EXCED_RANGE, ERROR_HANDLE_DISK_FULL, ERROR_HANDLE_EOF, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION, ERROR_WRITE_PROTECT, Info, STATUS_ACCESS_DENIED, STATUS_CANNOT_DELETE,
    STATUS_DELETE_PENDING, STATUS_DIRECTORY_NOT_EMPTY, STATUS_DISK_FULL,
    STATUS_FILE_IS_A_DIRECTORY, STATUS_MEDIA_WRITE_PROTECTED, STATUS_NAME_TOO_LONG,
    STATUS_NO_SUCH_FILE, STATUS_NOT_A_DIRECTORY, STATUS_OBJECT_NAME_COLLISION,
    STATUS_OBJECT_NAME_INVALID, STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
    STATUS_REPARSE_POINT_ENCOUNTERED, STATUS_SHARING_VIOLATION, STATUS_STOPPED_ON_SYMLINK, Shape,
    Share, Status,
};
use bun_native_windows_services::names;
use std::ffi::OsString;
use std::fs::File;
use std::io::{ErrorKind, Write as _};
use std::os::windows::fs::FileExt as _;
use std::os::windows::io::{AsHandle as _, BorrowedHandle, OwnedHandle};
use std::path::Path;

/// A grant is an open directory handle.
pub(crate) type Handle = OwnedHandle;

pub(super) const UNAVAILABLE: &str =
    "filesystem grants require Windows 10 1709 or later (OBJ_DONT_REPARSE confinement)";

const LINK: Failure = (
    ErrorCode::PathDenied,
    "the grant path crosses a symbolic link or leaves the grant root",
);
const ALIAS: Failure = (
    ErrorCode::PathDenied,
    "the grant path names a Windows device, stream, short name or other alias",
);
const WRONG_KIND: Failure = (
    ErrorCode::WrongKind,
    "the grant path names the wrong kind of file for this operation",
);
const NOT_FOUND: Failure = (ErrorCode::NotFound, "no file exists at this grant path");
const DENIED: Failure = (
    ErrorCode::AccessDenied,
    "the operating system denied this file operation",
);
const FULL: Failure = (ErrorCode::NativeFailure, "the filesystem is full");
const FAILED: Failure = (ErrorCode::NativeFailure, "the native file operation failed");

/// 100-nanosecond intervals between 1601-01-01 and 1970-01-01 UTC.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

pub(super) fn probe() -> bool {
    fs::probe()
}

pub(crate) fn open_root(path: &str) -> Result<Handle, Failure> {
    let root = fs::open_directory(Path::new(path)).map_err(io_failure)?;
    if !fs::info(root.as_handle()).map_err(io_failure)?.directory {
        return Err(WRONG_KIND);
    }
    Ok(root)
}

fn status_failure(Status(status): Status) -> Failure {
    match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND | STATUS_NO_SUCH_FILE => {
            NOT_FOUND
        }
        STATUS_OBJECT_NAME_COLLISION => (
            ErrorCode::AlreadyExists,
            "a file already exists at this grant path",
        ),
        STATUS_REPARSE_POINT_ENCOUNTERED | STATUS_STOPPED_ON_SYMLINK => LINK,
        STATUS_OBJECT_NAME_INVALID => ALIAS,
        STATUS_NOT_A_DIRECTORY | STATUS_FILE_IS_A_DIRECTORY => WRONG_KIND,
        STATUS_DIRECTORY_NOT_EMPTY => (ErrorCode::NotEmpty, "the directory is not empty"),
        STATUS_ACCESS_DENIED
        | STATUS_SHARING_VIOLATION
        | STATUS_DELETE_PENDING
        | STATUS_CANNOT_DELETE
        | STATUS_MEDIA_WRITE_PROTECTED => DENIED,
        STATUS_NAME_TOO_LONG => (ErrorCode::LimitExceeded, "the native path is too long"),
        STATUS_DISK_FULL => FULL,
        _ => FAILED,
    }
}

pub(crate) fn io_failure(error: std::io::Error) -> Failure {
    let Some(code) = error
        .raw_os_error()
        .and_then(|code| u32::try_from(code).ok())
    else {
        return FAILED;
    };
    match code {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => NOT_FOUND,
        ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS => (
            ErrorCode::AlreadyExists,
            "a file already exists at this grant path",
        ),
        ERROR_DIR_NOT_EMPTY => (ErrorCode::NotEmpty, "the directory is not empty"),
        ERROR_DIRECTORY => WRONG_KIND,
        ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_WRITE_PROTECT => DENIED,
        ERROR_FILENAME_EXCED_RANGE => (ErrorCode::LimitExceeded, "the native path is too long"),
        ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL => FULL,
        _ => FAILED,
    }
}

/// Opens one name beneath `parent`. A reparse point is refused unless the
/// operation examines the entry itself (`stat`, `remove`).
fn step(
    parent: BorrowedHandle<'_>,
    name: &str,
    access: Access,
    share: Share,
    create: Create,
    shape: Shape,
    examine: bool,
) -> Result<OwnedHandle, Failure> {
    names::plain(name).map_err(|_| ALIAS)?;
    match fs::open_beneath(parent, name, access, share, create, shape) {
        Ok(handle) => {
            if !examine
                && fs::info(handle.as_handle())
                    .map_err(io_failure)?
                    .reparse_point()
            {
                return Err(LINK);
            }
            Ok(handle)
        }
        Err(Status(STATUS_NOT_A_DIRECTORY | STATUS_FILE_IS_A_DIRECTORY)) => {
            // A link to the other kind fails the kind check first; report
            // every link refusal the same way.
            let link = fs::open_beneath(
                parent,
                name,
                Access::ATTRIBUTES,
                Share::All,
                Create::Existing,
                Shape::Any,
            )
            .ok()
            .and_then(|handle| fs::info(handle.as_handle()).ok())
            .is_some_and(|info| info.reparse_point());
            Err(if link { LINK } else { WRONG_KIND })
        }
        Err(status) => Err(status_failure(status)),
    }
}

/// The directory `names` reaches beneath `root`; `None` is the root itself.
fn descend(root: &Handle, names: &[&str]) -> Result<Option<OwnedHandle>, Failure> {
    let mut current: Option<OwnedHandle> = None;
    for name in names {
        let next = step(
            current.as_ref().unwrap_or(root).as_handle(),
            name,
            Access::LIST,
            Share::All,
            Create::Existing,
            Shape::Directory,
            false,
        )?;
        current = Some(next);
    }
    Ok(current)
}

fn same_path(left: &str, right: &str) -> bool {
    left.chars()
        .flat_map(char::to_uppercase)
        .eq(right.chars().flat_map(char::to_uppercase))
}

/// The opened entry's final path must be `root`'s plus exactly `names`.
fn confined(
    root: BorrowedHandle<'_>,
    opened: BorrowedHandle<'_>,
    names: &[&str],
) -> Result<(), Failure> {
    let root_path = fs::final_path(root, false).map_err(io_failure)?;
    let opened_path = fs::final_path(opened, false).map_err(io_failure)?;
    let mut expected = root_path
        .to_string_lossy()
        .trim_end_matches('\\')
        .to_owned();
    for name in names {
        expected.push('\\');
        expected.push_str(name);
    }
    if same_path(&expected, &opened_path.to_string_lossy()) {
        Ok(())
    } else {
        Err(ALIAS)
    }
}

/// Opens the entry `names` names beneath `root`, refusing every reparse
/// point unless `examine`, and checks where it resolved.
fn open(
    root: &Handle,
    names: &[&str],
    access: Access,
    create: Create,
    shape: Shape,
    examine: bool,
) -> Result<OwnedHandle, Failure> {
    let (name, parents) = names.split_last().ok_or(NOT_FOUND)?;
    let parent = descend(root, parents)?;
    let handle = step(
        parent.as_ref().unwrap_or(root).as_handle(),
        name,
        access,
        Share::All,
        create,
        shape,
        examine,
    )?;
    confined(root.as_handle(), handle.as_handle(), names)?;
    Ok(handle)
}

fn kind(attributes: u32, reparse_tag: u32, disk: bool) -> FileKind {
    if fs::name_surrogate(attributes, reparse_tag) {
        FileKind::Symlink
    } else if fs::reparse_attribute(attributes) {
        // Some other reparse point, such as a cloud placeholder. Never
        // opened for I/O through a grant.
        FileKind::Other
    } else if fs::directory_attribute(attributes) {
        FileKind::Directory
    } else if disk {
        FileKind::File
    } else {
        FileKind::Other
    }
}

fn regular(info: &Info) -> Result<(), Failure> {
    if info.directory || info.reparse_point() || !info.disk {
        return Err((
            ErrorCode::WrongKind,
            "the grant path does not name a regular file",
        ));
    }
    Ok(())
}

fn modified_ms(ticks: i64) -> i64 {
    let limit = i128::from(MAX_FILE_OFFSET);
    ((i128::from(ticks) - i128::from(UNIX_EPOCH_TICKS)).div_euclid(10_000)).clamp(-limit, limit)
        as i64
}

pub(super) fn serve(
    root: &Handle,
    path: &str,
    operation: &FileOperation,
) -> Result<FileResult, Failure> {
    let names: Vec<&str> = if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect()
    };
    match operation {
        FileOperation::Stat {} => {
            // The entry itself is examined: a link reports `symlink` and is not followed.
            let info = if names.is_empty() {
                fs::info(root.as_handle())
            } else {
                let handle = open(
                    root,
                    &names,
                    Access::ATTRIBUTES,
                    Create::Existing,
                    Shape::Any,
                    true,
                )?;
                fs::info(handle.as_handle())
            }
            .map_err(io_failure)?;
            Ok(FileResult::Stat {
                file_kind: kind(info.attributes, info.reparse_tag, info.disk),
                size: info.size.min(MAX_FILE_OFFSET),
                modified_ms: modified_ms(info.last_write),
            })
        }
        FileOperation::List { after } => {
            if names.is_empty() {
                list(root.as_handle(), after.as_deref())
            } else {
                let handle = open(
                    root,
                    &names,
                    Access::LIST,
                    Create::Existing,
                    Shape::Directory,
                    false,
                )?;
                list(handle.as_handle(), after.as_deref())
            }
        }
        FileOperation::Read { offset, length } => {
            if names.is_empty() {
                return Err(WRONG_KIND);
            }
            let handle = open(
                root,
                &names,
                Access::READ,
                Create::Existing,
                Shape::NonDirectory,
                false,
            )?;
            let info = fs::info(handle.as_handle()).map_err(io_failure)?;
            regular(&info)?;
            let file = File::from(handle);
            let mut buffer = vec![0; *length];
            let mut filled = 0;
            while filled < buffer.len() {
                match file.seek_read(&mut buffer[filled..], offset + filled as u64) {
                    Ok(0) => break,
                    Ok(read) => filled += read,
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(error) if error.raw_os_error() == Some(ERROR_HANDLE_EOF as i32) => break,
                    Err(error) => return Err(io_failure(error)),
                }
            }
            buffer.truncate(filled);
            Ok(FileResult::Read {
                data: STANDARD.encode(&buffer),
                end_of_file: filled < *length || offset + filled as u64 >= info.size,
            })
        }
        FileOperation::Write { mode, data } => {
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| (ErrorCode::InvalidCommand, "file data is not valid base64"))?;
            if names.is_empty() {
                return Err(WRONG_KIND);
            }
            // Never truncated at open: the kind is checked first.
            let (access, create) = match mode {
                WriteMode::Create => (Access::WRITE, Create::New),
                WriteMode::Truncate => (Access::WRITE, Create::Either),
                WriteMode::Append => (Access::APPEND, Create::Existing),
            };
            let handle = open(root, &names, access, create, Shape::NonDirectory, false)?;
            // Special files are refused before any byte is written or truncated.
            regular(&fs::info(handle.as_handle()).map_err(io_failure)?)?;
            let mut file = File::from(handle);
            if *mode == WriteMode::Truncate {
                file.set_len(0).map_err(io_failure)?;
            }
            file.write_all(&bytes).map_err(io_failure)?;
            Ok(FileResult::Written { bytes: bytes.len() })
        }
        FileOperation::CreateDirectory {} => {
            open(
                root,
                &names,
                Access::LIST,
                Create::New,
                Shape::Directory,
                false,
            )?;
            Ok(FileResult::Done {})
        }
        FileOperation::Remove {} => {
            // A link entry is removed itself; its target is untouched.
            let handle = open(
                root,
                &names,
                Access::DELETE,
                Create::Existing,
                Shape::Any,
                true,
            )?;
            fs::delete(handle.as_handle()).map_err(io_failure)?;
            Ok(FileResult::Done {})
        }
    }
}

fn list(directory: BorrowedHandle<'_>, after: Option<&str>) -> Result<FileResult, Failure> {
    let entries = fs::list(directory, MAX_SCANNED_ENTRIES)
        .map_err(io_failure)?
        .ok_or((ErrorCode::LimitExceeded, "directory exceeds 100000 entries"))?;
    let mut omitted = 0;
    let mut named = Vec::with_capacity(entries.len());
    for entry in entries {
        match OsString::into_string(entry.name) {
            Ok(name) if validate_file_name(&name).is_ok() && names::plain(&name).is_ok() => {
                named.push((name, kind(entry.attributes, entry.reparse_tag, true)));
            }
            _ => omitted += 1,
        }
    }
    named.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    let start = after.map_or(0, |after| {
        named.partition_point(|(name, _)| name.as_bytes() <= after.as_bytes())
    });
    let remaining = &named[start..];
    let page = &remaining[..remaining.len().min(MAX_DIRECTORY_ENTRIES)];
    Ok(FileResult::List {
        complete: page.len() == remaining.len(),
        entries: page
            .iter()
            .map(|(name, kind)| DirectoryEntry {
                name: name.clone(),
                kind: *kind,
            })
            .collect(),
        omitted,
    })
}

/// A process working directory: the directory `path` names beneath a grant,
/// with the root and every directory on the way down held open without
/// delete sharing, so none of them can be renamed, replaced or removed until
/// the child has started there, and its DOS path for `CreateProcessW`.
pub(crate) struct WorkingDirectory {
    _pinned: Vec<OwnedHandle>,
    pub(crate) path: OsString,
}

pub(crate) fn working_directory(root: &Handle, path: &str) -> Result<WorkingDirectory, Failure> {
    let names: Vec<&str> = if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect()
    };
    let mut pinned = vec![fs::pin_directory(root.as_handle()).map_err(io_failure)?];
    for name in &names {
        let parent = pinned.last().map(|handle| handle.as_handle());
        let next = step(
            parent.ok_or(FAILED)?,
            name,
            Access::LIST,
            Share::Pinned,
            Create::Existing,
            Shape::Directory,
            false,
        )?;
        pinned.push(next);
    }
    let leaf = pinned.last().ok_or(FAILED)?.as_handle();
    confined(pinned[0].as_handle(), leaf, &names)?;
    let path = fs::dos_path(&fs::final_path(leaf, true).map_err(io_failure)?);
    Ok(WorkingDirectory {
        _pinned: pinned,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "bun-native-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    /// A directory junction: no privilege is needed, unlike a symbolic link.
    fn junction(link: &Path, target: &Path) {
        let status = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn code(result: Result<FileResult, Failure>) -> ErrorCode {
        result.unwrap_err().0
    }

    fn read(root: &Handle, path: &str) -> Result<FileResult, Failure> {
        serve(
            root,
            path,
            &FileOperation::Read {
                offset: 0,
                length: 64,
            },
        )
    }

    fn write(
        root: &Handle,
        path: &str,
        mode: WriteMode,
        data: &[u8],
    ) -> Result<FileResult, Failure> {
        serve(
            root,
            path,
            &FileOperation::Write {
                mode,
                data: STANDARD.encode(data),
            },
        )
    }

    #[test]
    fn the_backend_is_available() {
        assert!(probe());
    }

    /// Requests stay beneath the grant without following any reparse point.
    #[test]
    fn confinement() {
        let base = temp();
        let root_path = base.join("root");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::write(base.join("secret"), b"outside").unwrap();
        junction(&root_path.join("up"), &base);
        std::fs::create_dir(root_path.join("inner")).unwrap();
        junction(&root_path.join("inner-link"), &root_path.join("inner"));
        // A file symbolic link needs a privilege the runner may lack.
        let file_link =
            std::os::windows::fs::symlink_file(base.join("secret"), root_path.join("link")).is_ok();
        let root = open_root(root_path.to_str().unwrap()).unwrap();

        assert_eq!(
            write(&root, "a.txt", WriteMode::Create, b"hello").unwrap(),
            FileResult::Written { bytes: 5 }
        );
        assert_eq!(
            code(write(&root, "a.txt", WriteMode::Create, b"x")),
            ErrorCode::AlreadyExists
        );
        write(&root, "a.txt", WriteMode::Append, b" world").unwrap();
        assert_eq!(
            serve(
                &root,
                "a.txt",
                &FileOperation::Read {
                    offset: 6,
                    length: 64
                }
            )
            .unwrap(),
            FileResult::Read {
                data: STANDARD.encode(b"world"),
                end_of_file: true
            }
        );
        write(&root, "a.txt", WriteMode::Truncate, b"new").unwrap();
        assert_eq!(std::fs::read(root_path.join("a.txt")).unwrap(), b"new");
        assert_eq!(
            code(write(&root, "missing", WriteMode::Append, b"x")),
            ErrorCode::NotFound
        );

        // Junctions are never followed, as the final name or mid-path.
        for path in ["up/secret", "inner-link/x"] {
            assert_eq!(code(read(&root, path)), ErrorCode::PathDenied, "{path}");
            assert_eq!(
                code(write(&root, path, WriteMode::Create, b"x")),
                ErrorCode::PathDenied,
                "{path}"
            );
        }
        for path in ["up", "inner-link"] {
            assert_eq!(
                code(serve(&root, path, &FileOperation::List { after: None })),
                ErrorCode::PathDenied,
                "{path}"
            );
            assert_eq!(
                code(serve(
                    &root,
                    &format!("{path}/new"),
                    &FileOperation::CreateDirectory {}
                )),
                ErrorCode::PathDenied
            );
            assert!(matches!(
                serve(&root, path, &FileOperation::Stat {}).unwrap(),
                FileResult::Stat {
                    file_kind: FileKind::Symlink,
                    ..
                }
            ));
        }
        if file_link {
            assert_eq!(code(read(&root, "link")), ErrorCode::PathDenied);
            assert_eq!(
                code(write(&root, "link", WriteMode::Truncate, b"x")),
                ErrorCode::PathDenied
            );
            assert_eq!(code(read(&root, "link/x")), ErrorCode::PathDenied);
        }
        assert!(!base.join("new").exists());
        assert!(!root_path.join("inner/new").exists());
        assert_eq!(std::fs::read(base.join("secret")).unwrap(), b"outside");

        serve(&root, "dir", &FileOperation::CreateDirectory {}).unwrap();
        write(&root, "dir/b", WriteMode::Create, b"").unwrap();
        assert_eq!(
            code(serve(&root, "dir", &FileOperation::Remove {})),
            ErrorCode::NotEmpty
        );
        assert_eq!(
            code(serve(&root, "a.txt/x", &FileOperation::Stat {})),
            ErrorCode::WrongKind
        );
        assert_eq!(
            code(write(&root, "dir", WriteMode::Truncate, b"x")),
            ErrorCode::WrongKind
        );
        assert_eq!(code(read(&root, "inner")), ErrorCode::WrongKind);
        assert_eq!(
            code(serve(&root, "missing", &FileOperation::Stat {})),
            ErrorCode::NotFound
        );

        let FileResult::List {
            entries, complete, ..
        } = serve(&root, "", &FileOperation::List { after: None }).unwrap()
        else {
            panic!("list result")
        };
        assert!(complete);
        let mut expected = vec![
            ("a.txt", FileKind::File),
            ("dir", FileKind::Directory),
            ("inner", FileKind::Directory),
            ("inner-link", FileKind::Symlink),
        ];
        if file_link {
            expected.push(("link", FileKind::Symlink));
        }
        expected.push(("up", FileKind::Symlink));
        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.kind))
                .collect::<Vec<_>>(),
            expected
        );

        // Removing a junction removes the entry, not its target.
        serve(&root, "up", &FileOperation::Remove {}).unwrap();
        assert!(!root_path.join("up").exists());
        assert!(base.join("secret").exists());
        serve(&root, "dir/b", &FileOperation::Remove {}).unwrap();
        serve(&root, "dir", &FileOperation::Remove {}).unwrap();
        assert!(!root_path.join("dir").exists());

        // A renamed root keeps its grant; the handle names the directory.
        let moved = base.join("moved");
        std::fs::rename(&root_path, &moved).unwrap();
        assert!(matches!(
            serve(&root, "a.txt", &FileOperation::Stat {}).unwrap(),
            FileResult::Stat { size: 3, .. }
        ));
        drop(root);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Streams, devices, second spellings and short names never reach an entry.
    #[test]
    fn windows_aliases_are_refused() {
        let base = temp();
        std::fs::write(base.join("long-file-name-secret.txt"), b"secret").unwrap();
        let root = open_root(base.to_str().unwrap()).unwrap();
        for path in [
            "long-file-name-secret.txt:stream",
            "long-file-name-secret.txt::$DATA",
            "CON",
            "nul.txt",
            "COM1",
            "long-file-name-secret.txt.",
            "long-file-name-secret.txt ",
            "a\\b",
            "C:",
        ] {
            assert_eq!(code(read(&root, path)), ErrorCode::PathDenied, "{path}");
            assert_eq!(
                code(write(&root, path, WriteMode::Truncate, b"x")),
                ErrorCode::PathDenied,
                "{path}"
            );
        }
        // An 8.3 short name is a second spelling of the long name. Volumes
        // may disable short names, in which case there is nothing to refuse.
        let output = Command::new("cmd.exe")
            .args(["/d", "/c", "for", "%I", "in"])
            .arg(format!(
                "({})",
                base.join("long-file-name-secret.txt").display()
            ))
            .args(["do", "@echo", "%~nxsI"])
            .output()
            .unwrap();
        let short = String::from_utf8(output.stdout).unwrap().trim().to_owned();
        if !short.is_empty() && !short.eq_ignore_ascii_case("long-file-name-secret.txt") {
            assert_eq!(code(read(&root, &short)), ErrorCode::PathDenied, "{short}");
        }
        assert_eq!(
            std::fs::read_dir(&base).unwrap().count(),
            1,
            "nothing was created"
        );
        drop(root);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_working_directory_is_pinned_and_confined() {
        let base = temp();
        std::fs::create_dir_all(base.join("root/sub")).unwrap();
        junction(&base.join("root/up"), &base);
        let root = open_root(base.join("root").to_str().unwrap()).unwrap();
        let directory = working_directory(&root, "sub").unwrap();
        assert!(same_path(
            &directory.path.to_string_lossy(),
            &fs::dos_path(base.join("root/sub").canonicalize().unwrap().as_os_str())
                .to_string_lossy()
        ));
        // Held without delete sharing: the directory cannot be renamed meanwhile.
        assert!(std::fs::rename(base.join("root/sub"), base.join("root/other")).is_err());
        drop(directory);
        std::fs::rename(base.join("root/sub"), base.join("root/other")).unwrap();
        assert_eq!(
            working_directory(&root, "up").err().unwrap().0,
            ErrorCode::PathDenied
        );
        assert_eq!(
            working_directory(&root, "missing").err().unwrap().0,
            ErrorCode::NotFound
        );
        drop(root);
        std::fs::remove_dir_all(&base).unwrap();
    }
}

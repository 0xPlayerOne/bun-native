//! Handle-relative file access that never follows a reparse point.
//!
//! [`open_beneath`] is the only way below a grant handle: `NtCreateFile` with
//! the parent handle as `RootDirectory` and one validated name, so the I/O
//! manager resolves exactly one directory entry of that parent. Every open
//! adds `FILE_OPEN_REPARSE_POINT`, so a symbolic link, junction, mount point
//! or other reparse point is opened as itself instead of being followed, and
//! `OBJ_DONT_REPARSE` (Windows 10 1709 and later) makes the object manager
//! fail rather than reparse anywhere in the lookup. Callers inspect
//! [`info`] and refuse reparse points they did not ask to examine.
#![allow(
    unsafe_code,
    reason = "the reviewed Win32 and NT file calls of this boundary"
)]

use crate::wide::terminated;
use std::ffi::{OsStr, OsString, c_void};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStringExt as _;
use std::os::windows::io::{
    AsHandle as _, AsRawHandle as _, BorrowedHandle, FromRawHandle as _, OwnedHandle,
};
use std::path::Path;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF,
    FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
};
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, ERROR_NOT_SUPPORTED,
    HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO,
    FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO,
    FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_FULL_DIR_INFO, FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_STANDARD_INFO, FILE_TRAVERSE, FILE_TYPE_DISK, FILE_WRITE_DATA, FileAttributeTagInfo,
    FileBasicInfo, FileDispositionInfo, FileDispositionInfoEx, FileFullDirectoryInfo,
    FileFullDirectoryRestartInfo, FileIdInfo, FileStandardInfo, GetFileInformationByHandleEx,
    GetFileType, GetFinalPathNameByHandleW, OPEN_EXISTING, SYNCHRONIZE, SetFileInformationByHandle,
    VOLUME_NAME_DOS, VOLUME_NAME_NT,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;

pub use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_BAD_EXE_FORMAT, ERROR_DIR_NOT_EMPTY,
    ERROR_DIRECTORY, ERROR_DISK_FULL, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND,
    ERROR_FILENAME_EXCED_RANGE, ERROR_HANDLE_DISK_FULL, ERROR_HANDLE_EOF,
    ERROR_NO_SYSTEM_RESOURCES, ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION, ERROR_WRITE_PROTECT, STATUS_ACCESS_DENIED, STATUS_CANNOT_DELETE,
    STATUS_DELETE_PENDING, STATUS_DIRECTORY_NOT_EMPTY, STATUS_DISK_FULL,
    STATUS_FILE_IS_A_DIRECTORY, STATUS_MEDIA_WRITE_PROTECTED, STATUS_NAME_TOO_LONG,
    STATUS_NO_SUCH_FILE, STATUS_NOT_A_DIRECTORY, STATUS_NOT_A_REPARSE_POINT,
    STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_INVALID, STATUS_OBJECT_NAME_NOT_FOUND,
    STATUS_OBJECT_PATH_NOT_FOUND, STATUS_REPARSE_POINT_ENCOUNTERED, STATUS_SHARING_VIOLATION,
    STATUS_STOPPED_ON_SYMLINK,
};

/// The `NTSTATUS` of a failed relative open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status(pub NTSTATUS);

/// Access rights for one open; `SYNCHRONIZE` is always added.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access(u32);

impl Access {
    pub const ATTRIBUTES: Self = Self(FILE_READ_ATTRIBUTES);
    pub const READ: Self = Self(FILE_READ_DATA | FILE_READ_ATTRIBUTES);
    pub const WRITE: Self = Self(FILE_WRITE_DATA | FILE_READ_ATTRIBUTES);
    /// Writes land at the end of the file, as with `O_APPEND`.
    pub const APPEND: Self = Self(FILE_APPEND_DATA | FILE_READ_ATTRIBUTES);
    pub const LIST: Self = Self(FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES);
    pub const DELETE: Self = Self(DELETE | FILE_READ_ATTRIBUTES);
}

/// What an open does when the entry is missing or present.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Create {
    /// Only an existing entry.
    Existing,
    /// Only a new entry (`O_CREAT | O_EXCL`).
    New,
    /// An existing entry or a new one; never truncates.
    Either,
}

/// The kind of entry an open requires.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Directory,
    NonDirectory,
    Any,
}

/// Sharing granted to other opens of the same entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Share {
    /// Others may read, write, rename and delete it.
    All,
    /// Others may read and write but not rename or delete it while this
    /// handle is open. Only effective with read, write or delete access.
    Pinned,
}

impl Share {
    fn mode(self) -> u32 {
        match self {
            Self::All => FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            Self::Pinned => FILE_SHARE_READ | FILE_SHARE_WRITE,
        }
    }
}

/// Opens `name`, one entry of `parent`, without following a reparse point.
/// Separators, streams, `.` and `..` are refused before any system call so
/// this cannot resolve anything but a direct child.
pub fn open_beneath(
    parent: BorrowedHandle<'_>,
    name: &str,
    access: Access,
    share: Share,
    create: Create,
    shape: Shape,
) -> Result<OwnedHandle, Status> {
    let refused = Status(STATUS_OBJECT_NAME_INVALID);
    if crate::names::plain(name).is_err() {
        return Err(refused);
    }
    let wide: Vec<u16> = name.encode_utf16().collect();
    let bytes = u16::try_from(wide.len() * 2).map_err(|_| refused)?;
    let object_name = UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: wide.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &object_name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let disposition = match create {
        Create::Existing => FILE_OPEN,
        Create::New => FILE_CREATE,
        Create::Either => FILE_OPEN_IF,
    };
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | match shape {
            Shape::Directory => FILE_DIRECTORY_FILE,
            Shape::NonDirectory => FILE_NON_DIRECTORY_FILE,
            Shape::Any => 0,
        };
    let mut handle: HANDLE = std::ptr::null_mut();
    let mut io_status = IO_STATUS_BLOCK::default();
    // SAFETY: every pointer refers to a live local for the duration of the
    // call (`wide` outlives `object_name`, which outlives `attributes`); the
    // root handle is borrowed and stays open; no EA buffer is passed.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access.0 | SYNCHRONIZE,
            &attributes,
            &mut io_status,
            std::ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share.mode(),
            disposition,
            options,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(Status(status));
    }
    // SAFETY: a successful NtCreateFile returned a new handle this call owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a valid handle a Win32 call just returned, owned by the caller.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Opens a trusted launch directory by path. The path may traverse links;
/// the handle, not the path, is the grant from here on.
pub fn open_directory(path: &Path) -> io::Result<OwnedHandle> {
    let wide = terminated(path.as_os_str())?;
    // SAFETY: `wide` is NUL-terminated and outlives the call; no security
    // attributes or template handle are passed.
    owned(unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            Share::All.mode(),
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    })
}

/// Opens an executable for launch by path, sharing only reads, so it cannot
/// be written, renamed or deleted while the handle is open.
pub fn open_executable(path: &Path) -> io::Result<OwnedHandle> {
    let wide = terminated(path.as_os_str())?;
    // SAFETY: as in `open_directory`.
    owned(unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    })
}

/// A second handle to the directory `handle` names, sharing only reads and
/// writes so the directory cannot be renamed or deleted while it is open.
///
/// `ReOpenFile` is refused with `ERROR_ACCESS_DENIED` for these handles on
/// hosted Windows, so the directory is opened again by its final path and the
/// two handles must name the same volume and file ID: a directory swapped in
/// between is rejected rather than pinned.
pub fn pin_directory(handle: BorrowedHandle<'_>) -> io::Result<OwnedHandle> {
    let path = final_path(handle, true)?;
    let wide = terminated(&path)?;
    // SAFETY: `wide` is NUL-terminated and outlives the call; no security
    // attributes or template handle are passed.
    let pinned = owned(unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            Share::Pinned.mode(),
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    })?;
    if file_id(pinned.as_handle())? != file_id(handle)? {
        return Err(io::Error::other(
            "the directory changed while it was pinned",
        ));
    }
    Ok(pinned)
}

/// The volume serial number and 128-bit file ID that name one file.
fn file_id(handle: BorrowedHandle<'_>) -> io::Result<(u64, [u8; 16])> {
    let id: FILE_ID_INFO = query(handle, FileIdInfo)?;
    Ok((id.VolumeSerialNumber, id.FileId.Identifier))
}

/// Whether the running system accepts `OBJ_DONT_REPARSE` relative opens.
pub fn probe() -> bool {
    let mut buffer = [0u16; 260];
    // SAFETY: the buffer and its length match.
    let length = unsafe { GetSystemWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    let Some(path) = buffer
        .get(..length as usize)
        .filter(|path| !path.is_empty())
    else {
        return false;
    };
    let windows = OsString::from_wide(path);
    open_directory(Path::new(&windows)).is_ok_and(|directory| {
        open_beneath(
            directory.as_handle(),
            "System32",
            Access::ATTRIBUTES,
            Share::All,
            Create::Existing,
            Shape::Directory,
        )
        .is_ok()
    })
}

/// What `stat` reports about an open handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Info {
    pub attributes: u32,
    /// The reparse tag when `attributes` has `FILE_ATTRIBUTE_REPARSE_POINT`.
    pub reparse_tag: u32,
    pub directory: bool,
    pub size: u64,
    /// 100-nanosecond intervals since 1601-01-01 UTC.
    pub last_write: i64,
    /// A file on a disk volume, not a character device or pipe.
    pub disk: bool,
}

impl Info {
    pub fn reparse_point(&self) -> bool {
        reparse_attribute(self.attributes)
    }
}

/// Whether a reparse point names another entry: a symbolic link, junction
/// or mount point rather than, say, a cloud placeholder.
pub fn name_surrogate(attributes: u32, reparse_tag: u32) -> bool {
    reparse_attribute(attributes) && reparse_tag & 0x2000_0000 != 0
}

pub fn reparse_attribute(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

pub fn directory_attribute(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_DIRECTORY != 0
}

fn query<T: Default>(handle: BorrowedHandle<'_>, class: i32) -> io::Result<T> {
    let mut value = T::default();
    // SAFETY: the buffer is a `T` of the size passed, matching `class` at every call site.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            class,
            (&raw mut value).cast::<c_void>(),
            size_of::<T>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(value)
}

pub fn info(handle: BorrowedHandle<'_>) -> io::Result<Info> {
    let basic: FILE_BASIC_INFO = query(handle, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = query(handle, FileStandardInfo)?;
    let tag: FILE_ATTRIBUTE_TAG_INFO = query(handle, FileAttributeTagInfo)?;
    // SAFETY: the handle is open for the duration of the call.
    let disk = unsafe { GetFileType(handle.as_raw_handle()) } == FILE_TYPE_DISK;
    Ok(Info {
        attributes: basic.FileAttributes,
        reparse_tag: tag.ReparseTag,
        directory: standard.Directory,
        size: u64::try_from(standard.EndOfFile).unwrap_or(0),
        last_write: basic.LastWriteTime,
        disk,
    })
}

/// The normalized final path of an open handle, with an NT device volume
/// (`\Device\HarddiskVolume3\…`) or a DOS one (`\\?\C:\…`).
pub fn final_path(handle: BorrowedHandle<'_>, dos: bool) -> io::Result<OsString> {
    let volume = if dos { VOLUME_NAME_DOS } else { VOLUME_NAME_NT };
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: the buffer and its length match.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | volume,
            )
        } as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(OsString::from_wide(&buffer));
        }
        // Too small: `length` is the size needed, including the NUL.
        buffer.resize(length, 0);
    }
}

/// One directory entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: OsString,
    pub attributes: u32,
    pub reparse_tag: u32,
}

/// Every entry of an open directory except `.` and `..`, or `None` when it
/// holds more than `limit`.
pub fn list(handle: BorrowedHandle<'_>, limit: usize) -> io::Result<Option<Vec<Entry>>> {
    // u64 storage keeps the 8-byte alignment the entries need.
    let mut buffer = vec![0u64; 8_192];
    let bytes = buffer.len() * size_of::<u64>();
    let name_offset = offset_of!(FILE_FULL_DIR_INFO, FileName);
    let mut entries = Vec::new();
    let mut class = FileFullDirectoryRestartInfo;
    loop {
        // SAFETY: the buffer and its byte length match.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast::<c_void>(),
                bytes as u32,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                return Ok(Some(entries));
            }
            return Err(error);
        }
        class = FileFullDirectoryInfo;
        let base = buffer.as_ptr().cast::<u8>();
        let mut offset = 0usize;
        loop {
            let malformed =
                || io::Error::new(io::ErrorKind::InvalidData, "malformed directory entry");
            if !offset.is_multiple_of(8) || offset + name_offset > bytes {
                return Err(malformed());
            }
            // SAFETY: the header lies within the buffer (checked above) at an
            // 8-byte aligned offset, as the system lays entries out.
            let header = unsafe { &*base.add(offset).cast::<FILE_FULL_DIR_INFO>() };
            let length = header.FileNameLength as usize;
            if !length.is_multiple_of(2) || offset + name_offset + length > bytes {
                return Err(malformed());
            }
            // SAFETY: the name lies within the buffer (checked above) and
            // u16-aligned after the 8-byte aligned header.
            let name = unsafe {
                std::slice::from_raw_parts(base.add(offset + name_offset).cast::<u16>(), length / 2)
            };
            if name != [u16::from(b'.')] && name != [u16::from(b'.'), u16::from(b'.')] {
                if entries.len() == limit {
                    return Ok(None);
                }
                entries.push(Entry {
                    name: OsString::from_wide(name),
                    attributes: header.FileAttributes,
                    // For a reparse point the EA size field holds its tag.
                    reparse_tag: header.EaSize,
                });
            }
            if header.NextEntryOffset == 0 {
                break;
            }
            offset += header.NextEntryOffset as usize;
        }
    }
}

/// Deletes the entry an open handle (with `DELETE` access) names. A reparse
/// point opened as itself is removed, never its target.
pub fn delete(handle: BorrowedHandle<'_>) -> io::Result<()> {
    let posix = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: the info struct matches the class and outlives the call.
    let ok = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle(),
            FileDispositionInfoEx,
            (&raw const posix).cast::<c_void>(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if ok != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    let unsupported = [
        ERROR_INVALID_PARAMETER,
        ERROR_NOT_SUPPORTED,
        ERROR_INVALID_FUNCTION,
    ];
    if !unsupported
        .iter()
        .any(|code| error.raw_os_error() == Some(*code as i32))
    {
        return Err(error);
    }
    // File systems without POSIX deletion remove the name when the last handle closes.
    let legacy = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: as above.
    let ok = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle(),
            FileDispositionInfo,
            (&raw const legacy).cast::<c_void>(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The path to pass to Win32 APIs that take a DOS path: `\\?\C:\x` becomes
/// `C:\x` and `\\?\UNC\s\x` becomes `\\s\x` when the result fits `MAX_PATH`.
pub fn dos_path(path: &OsStr) -> OsString {
    let Some(text) = path.to_str() else {
        return path.to_owned();
    };
    let plain = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\")
        && let [drive, b':', b'\\', ..] = rest.as_bytes()
        && drive.is_ascii_alphabetic()
    {
        rest.to_owned()
    } else {
        return path.to_owned();
    };
    if plain.len() < 260 {
        plain.into()
    } else {
        path.to_owned()
    }
}

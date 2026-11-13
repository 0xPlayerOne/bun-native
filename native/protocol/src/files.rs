//! Scoped filesystem grants. A grant names an immutable launch-policy root,
//! never a path chosen at run time. Request paths are relative to that root.

use crate::{
    MAX_DIRECTORY_ENTRIES, MAX_FILESYSTEM_ROOTS, MAX_FILE_CHUNK_BYTES, MAX_FILE_NAME_BYTES,
    MAX_FILE_PATH_BYTES, MAX_FILE_PATH_COMPONENTS, MAX_ROOT_ID_BYTES, MAX_ROOT_PATH_BYTES,
};
use serde::{Deserialize, Serialize};

/// Canonical padded base64 length of the largest chunk.
pub const MAX_FILE_CHUNK_BASE64: usize = MAX_FILE_CHUNK_BYTES.div_ceil(3) * 4;
/// Largest byte offset a read or stat reports: JavaScript's safe integer range.
pub const MAX_FILE_OFFSET: u64 = crate::MAX_ID;

/// The access a launch root allows. A grant may request at most this access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileAccess {
    Read,
    ReadWrite,
}

impl FileAccess {
    pub fn writable(self) -> bool {
        self == Self::ReadWrite
    }
}

/// One directory the trusted application named at native process launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilesystemRoot {
    pub id: String,
    pub path: String,
    pub access: FileAccess,
}

impl FilesystemRoot {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_root_id(&self.id)?;
        validate_root_path(&self.path)
    }
}

/// Lowercase ASCII letters, digits, `-` and `_`, starting with a letter.
pub fn validate_root_id(id: &str) -> Result<(), &'static str> {
    let mut bytes = id.bytes();
    if id.len() > MAX_ROOT_ID_BYTES
        || !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        || !bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
    {
        return Err(crate::limit_message!(
            "filesystem root ID must be 1-",
            { MAX_ROOT_ID_BYTES },
            " lowercase ASCII letters, digits, '-' or '_', starting with a letter"
        ));
    }
    Ok(())
}

/// An absolute, normalized path without control characters: a POSIX path
/// (`/srv/docs`) or a Windows drive path (`C:\srv\docs`; no UNC or `\\?\`
/// prefix, `/` or further `:`). The host accepts only its own platform's form. It
/// resolves the path once when a grant opens; later renames follow that
/// directory.
pub fn validate_root_path(path: &str) -> Result<(), &'static str> {
    if path.len() > MAX_ROOT_PATH_BYTES
        || path.chars().any(char::is_control)
        || !(posix_root_path(path) || windows_root_path(path))
    {
        return Err(crate::limit_message!(
            "filesystem root path must be absolute and normalized, at most ",
            { MAX_ROOT_PATH_BYTES },
            " bytes, without control characters"
        ));
    }
    Ok(())
}

fn normalized<'a>(mut components: impl Iterator<Item = &'a str>) -> bool {
    components.all(|component| !component.is_empty() && component != "." && component != "..")
}

/// `/` or `/`-joined names.
pub fn posix_root_path(path: &str) -> bool {
    path == "/"
        || path
            .strip_prefix('/')
            .is_some_and(|rest| normalized(rest.split('/')))
}

/// `X:\` alone or followed by `\`-joined names without `/` or `:`.
pub fn windows_root_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
        && (bytes.len() == 3
            || (!path[3..].contains(['/', ':']) && normalized(path[3..].split('\\'))))
}

/// A request path is empty (the root itself) or `/`-separated names. No
/// absolute, `.`/`..`, empty or control-character component is accepted.
pub fn validate_file_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() {
        return Ok(());
    }
    if path.len() > MAX_FILE_PATH_BYTES
        || path.split('/').count() > MAX_FILE_PATH_COMPONENTS
        || path
            .split('/')
            .any(|name| validate_file_name(name).is_err())
    {
        return Err(crate::limit_message!(
            "file path must be relative names joined by '/', at most ",
            { MAX_FILE_PATH_BYTES },
            " bytes and ",
            { MAX_FILE_PATH_COMPONENTS },
            " components, without '.', '..', empty or control-character names"
        ));
    }
    Ok(())
}

pub fn validate_file_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > MAX_FILE_NAME_BYTES
        || name.contains('/')
        || name.chars().any(char::is_control)
    {
        return Err(crate::limit_message!(
            "file name must be 1-",
            { MAX_FILE_NAME_BYTES },
            " bytes, not '.' or '..', without '/' or control characters"
        ));
    }
    Ok(())
}

/// Standard padded base64 of at most one chunk.
pub fn validate_chunk(data: &str) -> Result<(), &'static str> {
    let bytes = data.as_bytes();
    let padding = bytes.iter().rev().take_while(|&&byte| byte == b'=').count();
    if data.len() > MAX_FILE_CHUNK_BASE64
        || !data.len().is_multiple_of(4)
        || padding > 2
        || (data.len() / 4 * 3).saturating_sub(padding) > MAX_FILE_CHUNK_BYTES
        || bytes[..bytes.len() - padding]
            .iter()
            .any(|&byte| !(byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/'))
    {
        return Err(crate::limit_message!(
            "file data must be padded standard base64 of at most ",
            { MAX_FILE_CHUNK_BYTES },
            " bytes"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteMode {
    /// Create a new file; fails with `already_exists` if the name exists.
    Create,
    /// Create or truncate a regular file, then write from offset zero.
    Truncate,
    /// Append to an existing regular file.
    Append,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileOperation {
    Stat {},
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
    },
    Read {
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        offset: u64,
        length: usize,
    },
    Write {
        mode: WriteMode,
        data: String,
    },
    CreateDirectory {},
    Remove {},
}

impl FileOperation {
    pub fn writes(&self) -> bool {
        matches!(
            self,
            Self::Write { .. } | Self::CreateDirectory {} | Self::Remove {}
        )
    }

    pub fn validate(&self, path: &str) -> Result<(), &'static str> {
        validate_file_path(path)?;
        if self.writes() && path.is_empty() {
            return Err("the grant root itself cannot be written, created or removed");
        }
        match self {
            Self::List { after: Some(name) } => validate_file_name(name),
            Self::Read { offset, length } => {
                if *length == 0 || *length > MAX_FILE_CHUNK_BYTES {
                    Err(crate::limit_message!(
                        "file read length must be between 1 and ",
                        { MAX_FILE_CHUNK_BYTES },
                        " bytes"
                    ))
                } else if *offset > MAX_FILE_OFFSET - MAX_FILE_CHUNK_BYTES as u64 {
                    Err("file read offset exceeds the safe integer range")
                } else {
                    Ok(())
                }
            }
            Self::Write { data, .. } => validate_chunk(data),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: FileKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileResult {
    Stat {
        file_kind: FileKind,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        size: u64,
        /// Milliseconds since the Unix epoch; negative before it.
        modified_ms: i64,
    },
    /// Entries sorted by name after `after`. `omitted` counts names in this
    /// page's range that are not valid UTF-8 or contain control characters.
    List {
        entries: Vec<DirectoryEntry>,
        complete: bool,
        omitted: usize,
    },
    Read {
        data: String,
        end_of_file: bool,
    },
    Written {
        bytes: usize,
    },
    Done {},
}

impl FileResult {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Stat {
                size, modified_ms, ..
            } => {
                if *size > MAX_FILE_OFFSET || modified_ms.unsigned_abs() > MAX_FILE_OFFSET {
                    return Err("file metadata exceeds JavaScript's safe integer range");
                }
            }
            Self::List {
                entries, omitted, ..
            } => {
                if entries.len() > MAX_DIRECTORY_ENTRIES || *omitted > MAX_FILE_OFFSET as usize {
                    return Err(crate::limit_message!(
                        "directory page exceeds ",
                        { MAX_DIRECTORY_ENTRIES },
                        " entries"
                    ));
                }
                for (index, entry) in entries.iter().enumerate() {
                    validate_file_name(&entry.name)?;
                    if index > 0 && entries[index - 1].name.as_bytes() >= entry.name.as_bytes() {
                        return Err("directory entries must be unique and sorted by name");
                    }
                }
            }
            Self::Read { data, .. } => validate_chunk(data)?,
            Self::Written { bytes } if *bytes > MAX_FILE_CHUNK_BYTES => {
                return Err("written byte count exceeds one chunk");
            }
            Self::Written { .. } | Self::Done {} => {}
        }
        Ok(())
    }

    /// The result shape each operation produces.
    pub fn answers(&self, operation: &FileOperation) -> bool {
        matches!(
            (operation, self),
            (FileOperation::Stat {}, Self::Stat { .. })
                | (FileOperation::List { .. }, Self::List { .. })
                | (FileOperation::Read { .. }, Self::Read { .. })
                | (FileOperation::Write { .. }, Self::Written { .. })
                | (
                    FileOperation::CreateDirectory {} | FileOperation::Remove {},
                    Self::Done {}
                )
        )
    }
}

pub fn validate_filesystem_roots(roots: &[FilesystemRoot]) -> Result<(), &'static str> {
    if roots.len() > MAX_FILESYSTEM_ROOTS {
        return Err(crate::limit_message!(
            "at most ",
            { MAX_FILESYSTEM_ROOTS },
            " filesystem roots may be granted"
        ));
    }
    for (index, root) in roots.iter().enumerate() {
        root.validate()?;
        if roots[..index].iter().any(|other| other.id == root.id) {
            return Err("filesystem root IDs must be unique");
        }
    }
    Ok(())
}

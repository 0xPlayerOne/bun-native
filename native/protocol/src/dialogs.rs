//! Owned OS file dialogs. A selected path is data returned to the application,
//! never a filesystem grant: converting it into scoped authority is separate.

use crate::ErrorCode;
use serde::{Deserialize, Serialize};

/// Live file dialogs per session. Each window owns at most one at a time.
pub const MAX_FILE_DIALOGS: usize = 16;
pub const MAX_DIALOG_TITLE_BYTES: usize = 256;
pub const MAX_DIALOG_LABEL_BYTES: usize = 64;
pub const MAX_DIALOG_PATH_BYTES: usize = 4_096;
pub const MAX_DIALOG_NAME_BYTES: usize = 255;
pub const MAX_DIALOG_FILTERS: usize = 16;
pub const MAX_DIALOG_FILTER_PATTERNS: usize = 16;
pub const MAX_DIALOG_FILTER_NAME_BYTES: usize = 128;
pub const MAX_DIALOG_PATTERN_BYTES: usize = 64;
/// Selected paths in one result. The whole result must also fit one frame.
pub const MAX_DIALOG_PATHS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileDialogMode {
    OpenFile,
    OpenFiles,
    OpenDirectory,
    SaveFile,
}

impl FileDialogMode {
    /// Modes whose selection is exactly one path.
    pub fn single(self) -> bool {
        !matches!(self, Self::OpenFiles)
    }
}

/// A named set of shell-style glob patterns, e.g. `Text` with `*.txt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileFilter {
    pub name: String,
    pub patterns: Vec<String>,
}

fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileDialogOptions {
    pub mode: FileDialogMode,
    pub title: String,
    /// The accept button's label; the platform default when absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub accept_label: Option<String>,
    /// An absolute starting folder. A hint: the platform may ignore it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub folder: Option<String>,
    /// The suggested file name of a save dialog.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<FileFilter>,
}

fn line(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

/// A nonempty absolute POSIX path without NUL, at most 4096 UTF-8 bytes.
pub fn validate_dialog_path(path: &str) -> Result<(), &'static str> {
    if path.starts_with('/') && path.len() <= MAX_DIALOG_PATH_BYTES && !path.contains('\0') {
        Ok(())
    } else {
        Err("dialog path must be absolute, at most 4096 bytes and contain no NUL")
    }
}

impl FileDialogOptions {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !line(&self.title, MAX_DIALOG_TITLE_BYTES) {
            return Err(
                "dialog title must be nonempty, at most 256 bytes, and contain no control characters",
            );
        }
        if self
            .accept_label
            .as_ref()
            .is_some_and(|label| !line(label, MAX_DIALOG_LABEL_BYTES))
        {
            return Err(
                "dialog accept label must be nonempty, at most 64 bytes, and contain no control characters",
            );
        }
        if let Some(folder) = &self.folder {
            validate_dialog_path(folder)?;
        }
        if let Some(name) = &self.name {
            if self.mode != FileDialogMode::SaveFile {
                return Err("only a save dialog accepts a suggested name");
            }
            if !line(name, MAX_DIALOG_NAME_BYTES)
                || name.contains('/')
                || name == "."
                || name == ".."
            {
                return Err(
                    "suggested name must be one path component of at most 255 bytes without control characters",
                );
            }
        }
        if !self.filters.is_empty() && self.mode == FileDialogMode::OpenDirectory {
            return Err("a folder dialog does not accept file filters");
        }
        if self.filters.len() > MAX_DIALOG_FILTERS {
            return Err("a file dialog accepts at most 16 filters");
        }
        for filter in &self.filters {
            if !line(&filter.name, MAX_DIALOG_FILTER_NAME_BYTES)
                || filter.patterns.is_empty()
                || filter.patterns.len() > MAX_DIALOG_FILTER_PATTERNS
                || !filter
                    .patterns
                    .iter()
                    .all(|pattern| line(pattern, MAX_DIALOG_PATTERN_BYTES))
            {
                return Err(
                    "a file filter needs a name of at most 128 bytes and 1-16 patterns of at most 64 bytes, without control characters",
                );
            }
        }
        Ok(())
    }
}

/// A failed dialog has no partial selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileDialogFailure {
    NativeFailure,
    PayloadTooLarge,
}

impl From<FileDialogFailure> for ErrorCode {
    fn from(value: FileDialogFailure) -> Self {
        match value {
            FileDialogFailure::NativeFailure => Self::NativeFailure,
            FileDialogFailure::PayloadTooLarge => Self::PayloadTooLarge,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileDialogResult {
    /// Paths the user chose. Data only: no filesystem authority is attached.
    Selected {
        paths: Vec<String>,
    },
    /// The user dismissed the dialog without choosing.
    Cancelled {},
    Failed {
        code: FileDialogFailure,
    },
}

impl FileDialogResult {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Self::Selected { paths } = self {
            if paths.is_empty() || paths.len() > MAX_DIALOG_PATHS {
                return Err("a dialog selection holds between 1 and 256 paths");
            }
            for path in paths {
                validate_dialog_path(path)?;
            }
        }
        Ok(())
    }
}

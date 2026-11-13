//! Owned OS file dialogs. A selected path is data returned to the application,
//! never a filesystem grant: converting it into scoped authority is separate.

use crate::ErrorCode;
use crate::{
    MAX_DIALOG_FILTERS, MAX_DIALOG_FILTER_NAME_BYTES, MAX_DIALOG_FILTER_PATTERNS,
    MAX_DIALOG_LABEL_BYTES, MAX_DIALOG_NAME_BYTES, MAX_DIALOG_PATHS, MAX_DIALOG_PATH_BYTES,
    MAX_DIALOG_PATTERN_BYTES, MAX_DIALOG_TITLE_BYTES,
};
use serde::{Deserialize, Serialize};

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
        Err(crate::limit_message!(
            "dialog path must be absolute, at most ",
            { MAX_DIALOG_PATH_BYTES },
            " bytes and contain no NUL"
        ))
    }
}

impl FileDialogOptions {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !line(&self.title, MAX_DIALOG_TITLE_BYTES) {
            return Err(crate::limit_message!(
                "dialog title must be nonempty, at most ",
                { MAX_DIALOG_TITLE_BYTES },
                " bytes, and contain no control characters"
            ));
        }
        if self
            .accept_label
            .as_ref()
            .is_some_and(|label| !line(label, MAX_DIALOG_LABEL_BYTES))
        {
            return Err(crate::limit_message!(
                "dialog accept label must be nonempty, at most ",
                { MAX_DIALOG_LABEL_BYTES },
                " bytes, and contain no control characters"
            ));
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
                return Err(crate::limit_message!(
                    "suggested name must be one path component of at most ",
                    { MAX_DIALOG_NAME_BYTES },
                    " bytes without control characters"
                ));
            }
        }
        if !self.filters.is_empty() && self.mode == FileDialogMode::OpenDirectory {
            return Err("a folder dialog does not accept file filters");
        }
        if self.filters.len() > MAX_DIALOG_FILTERS {
            return Err(crate::limit_message!(
                "a file dialog accepts at most ",
                { MAX_DIALOG_FILTERS },
                " filters"
            ));
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
                return Err(crate::limit_message!(
                    "a file filter needs a name of at most ",
                    { MAX_DIALOG_FILTER_NAME_BYTES },
                    " bytes and 1-",
                    { MAX_DIALOG_FILTER_PATTERNS },
                    " patterns of at most ",
                    { MAX_DIALOG_PATTERN_BYTES },
                    " bytes, without control characters"
                ));
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
                return Err(crate::limit_message!(
                    "a dialog selection holds between 1 and ",
                    { MAX_DIALOG_PATHS },
                    " paths"
                ));
            }
            for path in paths {
                validate_dialog_path(path)?;
            }
        }
        Ok(())
    }
}

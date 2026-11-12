//! The platform-free rules of macOS file panels: which protocol filters a
//! panel can honor, and how a panel's selection becomes a protocol result.
//! Compiled on every platform for its tests.

use bun_native_protocol::{
    DialogId, ErrorCode, Event, EventSequence, FileDialogFailure, FileDialogMode, FileDialogResult,
    FileFilter, MAX_DIALOG_PATHS, MAX_FRAME_BYTES, MAX_ID, WindowId, validate_dialog_path,
};

type Failure = (ErrorCode, &'static str);

/// The file name extensions a panel may allow, from the protocol filters.
///
/// AppKit panels filter by content type, which this maps from `*.ext`
/// patterns only. `*` and `*.*` allow every file, so any filter holding one
/// leaves the panel unrestricted. Every other glob is refused rather than
/// approximated. A panel shows no filter chooser: the union of every filter's
/// extensions is allowed at once.
pub(crate) fn extensions(filters: &[FileFilter]) -> Result<Vec<String>, Failure> {
    let mut extensions: Vec<String> = Vec::new();
    let mut everything = false;
    for pattern in filters.iter().flat_map(|filter| &filter.patterns) {
        if pattern == "*" || pattern == "*.*" {
            everything = true;
            continue;
        }
        let extension = pattern
            .strip_prefix("*.")
            .filter(|extension| {
                !extension.is_empty()
                    && extension
                        .chars()
                        .all(|character| character.is_alphanumeric() || "-_+".contains(character))
            })
            .ok_or((
                ErrorCode::ServiceUnavailable,
                "macOS file panels filter only by *.ext patterns",
            ))?;
        if !extensions.iter().any(|known| known == extension) {
            extensions.push(extension.to_owned());
        }
    }
    if everything {
        extensions.clear();
    }
    Ok(extensions)
}

/// The protocol result for paths a panel accepted.
pub(crate) fn selected(mode: FileDialogMode, paths: Vec<String>) -> FileDialogResult {
    let failed = |code| FileDialogResult::Failed { code };
    if paths.len() > MAX_DIALOG_PATHS {
        return failed(FileDialogFailure::PayloadTooLarge);
    }
    if paths.is_empty() || (mode.single() && paths.len() != 1) {
        return failed(FileDialogFailure::NativeFailure);
    }
    if paths.iter().any(|path| validate_dialog_path(path).is_err()) {
        return failed(FileDialogFailure::NativeFailure);
    }
    FileDialogResult::Selected { paths }
}

/// A selection whose completion event would not fit one frame is too large.
pub(crate) fn fit_frame(
    window: WindowId,
    dialog: DialogId,
    result: FileDialogResult,
) -> FileDialogResult {
    let Ok(sequence) = EventSequence::try_from(MAX_ID) else {
        return result;
    };
    let event = Event::FileDialogCompleted {
        sequence,
        window_id: window,
        dialog_id: dialog,
        result,
    };
    let fits = serde_json::to_vec(&event).is_ok_and(|bytes| bytes.len() <= MAX_FRAME_BYTES);
    let Event::FileDialogCompleted { result, .. } = event else {
        unreachable!("constructed above")
    };
    if fits {
        result
    } else {
        FileDialogResult::Failed {
            code: FileDialogFailure::PayloadTooLarge,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(patterns: &[&str]) -> FileFilter {
        FileFilter {
            name: "Filter".into(),
            patterns: patterns.iter().map(|pattern| (*pattern).into()).collect(),
        }
    }

    #[test]
    fn extension_patterns_are_unioned_in_order_without_duplicates() {
        assert_eq!(extensions(&[]), Ok(vec![]));
        assert_eq!(
            extensions(&[
                filter(&["*.txt", "*.md"]),
                filter(&["*.md", "*.tar-gz", "*.c++"])
            ]),
            Ok(vec![
                "txt".into(),
                "md".into(),
                "tar-gz".into(),
                "c++".into()
            ])
        );
    }

    #[test]
    fn a_match_everything_pattern_leaves_the_panel_unrestricted() {
        assert_eq!(
            extensions(&[filter(&["*.txt"]), filter(&["*"])]),
            Ok(vec![])
        );
        assert_eq!(extensions(&[filter(&["*.*", "*.txt"])]), Ok(vec![]));
    }

    #[test]
    fn globs_a_panel_cannot_honor_are_refused() {
        for pattern in [
            "*.",
            "*.tar.gz",
            "*.t?t",
            "*.[ch]",
            "report*.txt",
            "*txt",
            "README",
            "*.a/b",
            "*.a b",
        ] {
            assert_eq!(
                extensions(&[filter(&["*.txt", pattern])]).unwrap_err().0,
                ErrorCode::ServiceUnavailable,
                "{pattern}"
            );
        }
    }

    #[test]
    fn selections_respect_mode_and_path_rules() {
        let one = vec!["/tmp/a".to_owned()];
        let two = vec!["/tmp/a".to_owned(), "/tmp/b".to_owned()];
        assert_eq!(
            selected(FileDialogMode::OpenFile, one.clone()),
            FileDialogResult::Selected { paths: one.clone() }
        );
        assert_eq!(
            selected(FileDialogMode::OpenFiles, two.clone()),
            FileDialogResult::Selected { paths: two.clone() }
        );
        for mode in [
            FileDialogMode::OpenFile,
            FileDialogMode::OpenDirectory,
            FileDialogMode::SaveFile,
        ] {
            assert_eq!(
                selected(mode, two.clone()),
                FileDialogResult::Failed {
                    code: FileDialogFailure::NativeFailure
                }
            );
        }
        assert_eq!(
            selected(FileDialogMode::OpenFiles, vec![]),
            FileDialogResult::Failed {
                code: FileDialogFailure::NativeFailure
            }
        );
        assert_eq!(
            selected(FileDialogMode::OpenFile, vec!["relative".into()]),
            FileDialogResult::Failed {
                code: FileDialogFailure::NativeFailure
            }
        );
        assert_eq!(
            selected(
                FileDialogMode::OpenFiles,
                vec!["/x".into(); MAX_DIALOG_PATHS + 1]
            ),
            FileDialogResult::Failed {
                code: FileDialogFailure::PayloadTooLarge
            }
        );
    }

    #[test]
    fn a_result_too_large_for_one_frame_fails() {
        let window = WindowId::try_from(1).unwrap();
        let dialog = DialogId::try_from(1).unwrap();
        let small = FileDialogResult::Selected {
            paths: vec!["/a".into()],
        };
        assert_eq!(fit_frame(window, dialog, small.clone()), small);
        let huge = FileDialogResult::Selected {
            paths: vec![format!("/{}", "x".repeat(4_000)); MAX_DIALOG_PATHS],
        };
        assert_eq!(
            fit_frame(window, dialog, huge),
            FileDialogResult::Failed {
                code: FileDialogFailure::PayloadTooLarge
            }
        );
    }
}

//! Window-owned `NSOpenPanel` / `NSSavePanel` sheets for OS file dialogs.
//!
//! Like an alert sheet, a panel sheet runs no nested event loop:
//! `beginSheetModalForWindow` returns at once and AppKit calls the completion
//! handler from the main run loop. The owner window is document-modal while
//! the sheet is attached. A sheet ended by the application reports
//! [`PanelEnd::Closed`]. Selected file URLs are returned as absolute paths;
//! the panel's own security scope is never kept.

use crate::alert::AlertOwner;
use crate::{SurfaceError, main_thread};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{
    NSModalResponse, NSModalResponseAbort, NSModalResponseCancel, NSModalResponseOK, NSOpenPanel,
    NSSavePanel, NSWindow,
};
use objc2_foundation::{NSArray, NSString, NSURL};
use objc2_uniform_type_identifiers::UTType;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelMode {
    OpenFile,
    OpenFiles,
    OpenDirectory,
    Save,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelSpec {
    pub mode: PanelMode,
    /// Shown as the panel's message, so the sheet names its purpose, and set
    /// as its window title for assistive technology.
    pub title: String,
    /// The accept button's title; AppKit's default when absent.
    pub prompt: Option<String>,
    /// An absolute starting folder.
    pub folder: Option<String>,
    /// The suggested file name of a save panel.
    pub name: Option<String>,
    /// File name extensions that may be chosen, without the dot. Empty means
    /// every file.
    pub extensions: Vec<String>,
}

/// How a panel ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelEnd {
    /// The user accepted these absolute paths.
    Selected(Vec<String>),
    /// The user dismissed the panel.
    Cancelled,
    /// The application ended the sheet, or AppKit reported a response or a
    /// URL this panel cannot represent.
    Closed,
}

enum Kind {
    Open(Retained<NSOpenPanel>),
    Save(Retained<NSSavePanel>),
}

impl Kind {
    fn panel(&self) -> &NSSavePanel {
        match self {
            Self::Open(panel) => panel,
            Self::Save(panel) => panel,
        }
    }

    fn urls(&self) -> Vec<Retained<NSURL>> {
        match self {
            Self::Open(panel) => panel.URLs().to_vec(),
            Self::Save(panel) => panel.URL().into_iter().collect(),
        }
    }
}

/// Map the panel's response and URLs. Only file URLs with a path count.
fn ended(response: NSModalResponse, urls: impl FnOnce() -> Vec<Option<String>>) -> PanelEnd {
    if response == NSModalResponseCancel {
        return PanelEnd::Cancelled;
    }
    if response != NSModalResponseOK {
        return PanelEnd::Closed;
    }
    let paths: Option<Vec<String>> = urls().into_iter().collect();
    match paths {
        Some(paths) if !paths.is_empty() => PanelEnd::Selected(paths),
        _ => PanelEnd::Closed,
    }
}

fn file_path(url: &NSURL) -> Option<String> {
    if !url.isFileURL() {
        return None;
    }
    url.path().map(|path| path.to_string())
}

/// A shown panel sheet. Dropping it does not end the sheet; [`Panel::close`]
/// does.
pub struct Panel {
    kind: Kind,
    owner: AlertOwner,
}

impl Panel {
    /// End the sheet now. The completion handler reports
    /// [`PanelEnd::Closed`]. Ending a sheet that already ended does nothing.
    pub fn close(&self) {
        let sheet: &NSWindow = self.kind.panel();
        let owner = &self.owner.0;
        if owner
            .attachedSheet()
            .is_some_and(|attached| &*attached == sheet)
        {
            owner.endSheet_returnCode(sheet, NSModalResponseAbort);
        } else {
            // Queued behind another sheet, or already gone: take it off screen.
            sheet.orderOut(None);
        }
    }
}

/// Attach the panel to `owner` as a sheet. `done` runs exactly once on the
/// main thread when the sheet ends.
pub fn show(
    owner: &AlertOwner,
    spec: &PanelSpec,
    done: impl Fn(PanelEnd) + 'static,
) -> Result<Panel, SurfaceError> {
    let main_thread = main_thread()?;
    let kind = match spec.mode {
        PanelMode::Save => Kind::Save(NSSavePanel::savePanel(main_thread)),
        mode => {
            let panel = NSOpenPanel::openPanel(main_thread);
            panel.setCanChooseFiles(mode != PanelMode::OpenDirectory);
            panel.setCanChooseDirectories(mode == PanelMode::OpenDirectory);
            panel.setAllowsMultipleSelection(mode == PanelMode::OpenFiles);
            Kind::Open(panel)
        }
    };
    let panel = kind.panel();
    let title = NSString::from_str(&spec.title);
    panel.setTitle(Some(&title));
    panel.setMessage(Some(&title));
    if let Some(prompt) = &spec.prompt {
        panel.setPrompt(Some(&NSString::from_str(prompt)));
    }
    if let Some(folder) = &spec.folder {
        panel.setDirectoryURL(Some(&NSURL::fileURLWithPath_isDirectory(
            &NSString::from_str(folder),
            true,
        )));
    }
    if let Some(name) = &spec.name {
        panel.setNameFieldStringValue(&NSString::from_str(name));
    }
    if matches!(kind, Kind::Save(_)) {
        panel.setCanCreateDirectories(true);
    }
    if !spec.extensions.is_empty() {
        let types: Option<Vec<Retained<UTType>>> = spec
            .extensions
            .iter()
            .map(|extension| UTType::typeWithFilenameExtension(&NSString::from_str(extension)))
            .collect();
        let types = types.ok_or(SurfaceError::InvalidPanel)?;
        panel.setAllowedContentTypes(&NSArray::from_retained_slice(&types));
    }
    let reported = std::cell::Cell::new(false);
    let urls_of = match &kind {
        Kind::Open(panel) => Kind::Open(panel.clone()),
        Kind::Save(panel) => Kind::Save(panel.clone()),
    };
    let handler = RcBlock::new(move |response: NSModalResponse| {
        if !reported.replace(true) {
            done(ended(response, || {
                urls_of.urls().iter().map(|url| file_path(url)).collect()
            }));
        }
    });
    panel.beginSheetModalForWindow_completionHandler(&owner.0, &handler);
    Ok(Panel {
        kind,
        owner: owner.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(values: &[Option<&str>]) -> impl FnOnce() -> Vec<Option<String>> {
        let values: Vec<Option<String>> = values.iter().map(|v| v.map(String::from)).collect();
        move || values
    }

    #[test]
    fn responses_map_to_selection_cancel_or_closed() {
        assert_eq!(
            ended(NSModalResponseOK, paths(&[Some("/a"), Some("/b c")])),
            PanelEnd::Selected(vec!["/a".into(), "/b c".into()])
        );
        assert_eq!(
            ended(NSModalResponseCancel, paths(&[Some("/a")])),
            PanelEnd::Cancelled
        );
        assert_eq!(
            ended(NSModalResponseAbort, paths(&[Some("/a")])),
            PanelEnd::Closed
        );
        // An accepted panel without a usable file URL has no partial result.
        assert_eq!(ended(NSModalResponseOK, paths(&[])), PanelEnd::Closed);
        assert_eq!(
            ended(NSModalResponseOK, paths(&[Some("/a"), None])),
            PanelEnd::Closed
        );
    }
}

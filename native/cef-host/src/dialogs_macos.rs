//! Main-thread owned AppKit panels. CEF's renderer chooser remains denied.
use super::{dismissed, Kind, Options};
use block2::RcBlock;
use cef::{ImplWindow, Window};
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{
    NSModalResponseCancel, NSModalResponseOK, NSOpenPanel, NSSavePanel, NSView, NSWindow,
};
use objc2_foundation::{NSString, NSURL};

#[derive(Clone)]
enum NativePanel {
    Open(Retained<NSOpenPanel>),
    Save(Retained<NSSavePanel>),
}
#[derive(Clone)]
pub(super) struct Panel {
    native: NativePanel,
    owner: Retained<NSWindow>,
}
impl Panel {
    fn base(&self) -> &NSSavePanel {
        match &self.native {
            NativePanel::Open(panel) => panel,
            NativePanel::Save(panel) => panel,
        }
    }
    pub(super) fn show(&self, token: u64) {
        let handler = RcBlock::new(move |response| {
            dismissed(
                token,
                response == NSModalResponseOK,
                if response == NSModalResponseOK || response == NSModalResponseCancel {
                    None
                } else {
                    Some("NATIVE_FAILURE")
                },
            );
        });
        self.base()
            .beginSheetModalForWindow_completionHandler(&self.owner, &handler);
    }
    pub(super) fn cancel(&self) {
        unsafe {
            self.base().cancel(None);
        }
    }
    pub(super) fn close(&self) -> bool {
        // AppKit documents that the sheet may remain onscreen during completion.
        self.base().orderOut(None);
        !self.base().isVisible()
    }
    #[cfg(feature = "rpc-qualification")]
    pub(super) fn visible(&self) -> bool {
        self.base().isVisible()
    }
    pub(super) fn selected_path(&self) -> Result<String, String> {
        let url = self
            .base()
            .URL()
            .filter(|url| url.isFileURL())
            .ok_or("Native file selection is not a file URL")?;
        let path = url.path().ok_or("Native file selection has no path")?;
        // Bound before allocation and reject unpaired NSString UTF-16 units.
        let length = path.length();
        if length == 0 || length > 4096 {
            return Err("Native selected path exceeds bounds".into());
        }
        let mut units = vec![0u16; length];
        unsafe {
            path.getCharacters_range(
                std::ptr::NonNull::new(units.as_mut_ptr()).unwrap(),
                objc2_foundation::NSRange::new(0, length),
            );
        }
        let mut value = String::new();
        for unit in char::decode_utf16(units) {
            let scalar = unit.map_err(|_| "Native selected path has invalid Unicode")?;
            if value.len() + scalar.len_utf8() > 4096 {
                return Err("Native selected path exceeds bounds".into());
            }
            value.push(scalar);
        }
        Ok(value)
    }
}
pub(super) fn prepare(options: &Options, window: &Window) -> Result<Panel, String> {
    let mtm = MainThreadMarker::new().ok_or("File dialog requires the native main thread")?;
    let handle = window.window_handle();
    // Pinned CEF view_util_mac.mm returns the widget's NSView*, not NSWindow*.
    // Resolve and retain its owner before entering any AppKit callback.
    let view = unsafe { Retained::retain(handle.cast::<NSView>()) }
        .ok_or("File dialog owner view unavailable")?;
    let owner = view
        .window()
        .ok_or("File dialog owner window unavailable")?;
    if !owner.isVisible() || owner.isMiniaturized() {
        return Err("RESOURCE_IN_USE: file dialog owner must be visible and restored".into());
    }
    let native = if options.kind == Kind::Open {
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setAllowsMultipleSelection(false);
        panel.setCanChooseDirectories(false);
        panel.setCanChooseFiles(true);
        panel.setResolvesAliases(false);
        NativePanel::Open(panel)
    } else {
        NativePanel::Save(NSSavePanel::savePanel(mtm))
    };
    let panel = Panel { native, owner };
    let base = panel.base();
    base.setTitle(Some(&NSString::from_str(&options.title)));
    base.setCanCreateDirectories(false);
    base.setTreatsFilePackagesAsDirectories(false);
    base.setShowsHiddenFiles(false);
    base.setDirectoryURL(Some(&NSURL::fileURLWithPath_isDirectory(
        &NSString::from_str(&options.directory),
        true,
    )));
    if options.kind == Kind::Save {
        base.setNameFieldStringValue(&NSString::from_str(&options.suggested_name));
    }
    Ok(panel)
}

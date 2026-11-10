//! Window-owned `NSAlert` sheets for OS message dialogs.
//!
//! A sheet runs no nested event loop: `beginSheetModalForWindow` returns at
//! once and AppKit calls the completion handler from the main run loop, so
//! GPUI keeps processing other windows, commands and timers. The owner window
//! is document-modal while the sheet is attached. A sheet ended by the
//! application reports [`AlertEnd::Closed`], never a button.

use crate::{SurfaceError, appkit, main_thread};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSEventModifierFlags, NSModalResponse, NSModalResponseAbort,
    NSView, NSWindow,
};
use objc2_foundation::NSString;
use raw_window_handle::WindowHandle;

/// The most buttons an alert carries, as on the overlay and Windows.
pub const MAX_BUTTONS: usize = 4;

/// Which key ends the alert through a button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertKey {
    /// Return (and Enter) press this button.
    Return,
    /// Escape presses this button.
    Escape,
    /// No key equivalent: only a click or keyboard focus presses it.
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlertButton {
    pub title: String,
    pub key: AlertKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlertSpec {
    /// The alert's window title. A sheet shows no title bar; assistive
    /// technology reads it.
    pub title: String,
    /// The bold message text.
    pub message: String,
    /// The smaller informative text under it.
    pub informative: Option<String>,
    /// Buttons in the order added: AppKit places the first one rightmost.
    pub buttons: Vec<AlertButton>,
}

impl AlertSpec {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.buttons.is_empty() || self.buttons.len() > MAX_BUTTONS {
            return Err("an alert needs between 1 and 4 buttons");
        }
        for key in [AlertKey::Return, AlertKey::Escape] {
            if self
                .buttons
                .iter()
                .filter(|button| button.key == key)
                .count()
                > 1
            {
                return Err("at most one button may own a key");
            }
        }
        Ok(())
    }
}

/// How a sheet ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertEnd {
    /// The button at this index of the spec was pressed.
    Button(usize),
    /// The application ended the sheet, or AppKit reported a response this
    /// alert never offered.
    Closed,
}

/// Map the modal response AppKit reports for an alert with `buttons` buttons.
pub fn ended(buttons: usize, response: NSModalResponse) -> AlertEnd {
    response
        .checked_sub(NSAlertFirstButtonReturn)
        .and_then(|index| usize::try_from(index).ok())
        .filter(|index| *index < buttons)
        .map_or(AlertEnd::Closed, AlertEnd::Button)
}

/// The window an alert sheet attaches to.
#[derive(Clone, Debug)]
pub struct AlertOwner(Retained<NSWindow>);

/// The `NSWindow` of a borrowed GPUI view.
#[allow(unsafe_code)] // The same reviewed borrowed-view dereference as the surface access.
pub fn owner(handle: WindowHandle<'_>) -> Result<AlertOwner, SurfaceError> {
    let _main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.window()
        .map(AlertOwner)
        .ok_or(SurfaceError::MissingWindow)
}

/// A shown sheet. Dropping it does not end the sheet; [`Alert::close`] does.
pub struct Alert {
    alert: Retained<NSAlert>,
    owner: Retained<NSWindow>,
}

impl Alert {
    /// End the sheet now. The completion handler reports
    /// [`AlertEnd::Closed`]. Ending a sheet that already ended does nothing.
    pub fn close(&self) {
        let sheet = self.alert.window();
        if self
            .owner
            .attachedSheet()
            .is_some_and(|attached| attached == sheet)
        {
            self.owner.endSheet_returnCode(&sheet, NSModalResponseAbort);
        } else {
            // Queued behind another sheet, or already gone: take it off screen.
            sheet.orderOut(None);
        }
    }
}

/// Attach the alert to `owner` as a sheet. `done` runs exactly once on the
/// main thread when the sheet ends.
pub fn show(
    owner: &AlertOwner,
    spec: &AlertSpec,
    done: impl Fn(AlertEnd) + 'static,
) -> Result<Alert, SurfaceError> {
    let main_thread = main_thread()?;
    spec.validate().map_err(|_| SurfaceError::InvalidAlert)?;
    let alert = NSAlert::new(main_thread);
    alert.setMessageText(&NSString::from_str(&spec.message));
    if let Some(informative) = &spec.informative {
        alert.setInformativeText(&NSString::from_str(informative));
    }
    for button in &spec.buttons {
        let added = alert.addButtonWithTitle(&NSString::from_str(&button.title));
        // AppKit assigns Return to the first button, Escape to one titled
        // Cancel and Command-D to Don't Save. Replace every assignment.
        added.setKeyEquivalent(&NSString::from_str(match button.key {
            AlertKey::Return => "\r",
            AlertKey::Escape => "\u{1b}",
            AlertKey::None => "",
        }));
        added.setKeyEquivalentModifierMask(NSEventModifierFlags::empty());
    }
    alert.window().setTitle(&NSString::from_str(&spec.title));
    let buttons = spec.buttons.len();
    let reported = std::cell::Cell::new(false);
    let handler = RcBlock::new(move |response: NSModalResponse| {
        if !reported.replace(true) {
            done(ended(buttons, response));
        }
    });
    alert.beginSheetModalForWindow_completionHandler(&owner.0, Some(&handler));
    Ok(Alert {
        alert,
        owner: owner.0.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(keys: &[AlertKey]) -> AlertSpec {
        AlertSpec {
            title: "Title".into(),
            message: "Message".into(),
            informative: None,
            buttons: keys
                .iter()
                .enumerate()
                .map(|(index, key)| AlertButton {
                    title: format!("B{index}"),
                    key: *key,
                })
                .collect(),
        }
    }

    #[test]
    fn buttons_are_bounded_and_each_key_has_one_owner() {
        assert!(spec(&[AlertKey::Return]).validate().is_ok());
        assert!(
            spec(&[
                AlertKey::Return,
                AlertKey::None,
                AlertKey::None,
                AlertKey::Escape
            ])
            .validate()
            .is_ok()
        );
        assert!(spec(&[]).validate().is_err());
        assert!(spec(&[AlertKey::None; 5]).validate().is_err());
        assert!(
            spec(&[AlertKey::Return, AlertKey::Return])
                .validate()
                .is_err()
        );
        assert!(
            spec(&[AlertKey::Escape, AlertKey::Escape])
                .validate()
                .is_err()
        );
    }

    #[test]
    fn responses_map_back_to_offered_buttons_only() {
        assert_eq!(ended(3, NSAlertFirstButtonReturn), AlertEnd::Button(0));
        assert_eq!(ended(3, NSAlertFirstButtonReturn + 2), AlertEnd::Button(2));
        for response in [
            NSModalResponseAbort,
            -1000,
            0,
            1,
            NSAlertFirstButtonReturn - 1,
            NSAlertFirstButtonReturn + 3,
            NSModalResponse::MIN,
            NSModalResponse::MAX,
        ] {
            assert_eq!(ended(3, response), AlertEnd::Closed, "{response}");
        }
    }
}

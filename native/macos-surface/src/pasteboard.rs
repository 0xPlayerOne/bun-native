//! Plain text on the general pasteboard, for explicit programmatic clipboard
//! requests.
//!
//! Only the `public.utf8-plain-text` flavor is read or written. A write
//! replaces every flavor on the pasteboard with that one string; a read of a
//! pasteboard without a plain-text flavor reports no text. Nothing is cached:
//! each call asks the pasteboard server. A provider that promised its data
//! lazily is asked by AppKit, which bounds that request with its own timeout.

use crate::{SurfaceError, main_thread};
use objc2_app_kit::NSPasteboard;
use objc2_foundation::NSString;

/// `NSPasteboardTypeString`, spelled out so no foreign static is read.
const PLAIN_TEXT: &str = "public.utf8-plain-text";

/// The general pasteboard's plain text, or `None` when it holds none.
pub fn read_text() -> Result<Option<String>, SurfaceError> {
    let _main_thread = main_thread()?;
    let pasteboard = NSPasteboard::generalPasteboard();
    Ok(pasteboard
        .stringForType(&NSString::from_str(PLAIN_TEXT))
        .map(|text| text.to_string()))
}

/// Replace the general pasteboard's contents with `text`.
pub fn write_text(text: &str) -> Result<(), SurfaceError> {
    let _main_thread = main_thread()?;
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.setString_forType(&NSString::from_str(text), &NSString::from_str(PLAIN_TEXT)) {
        Ok(())
    } else {
        Err(SurfaceError::PasteboardRefused)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workers_cannot_touch_the_pasteboard() {
        std::thread::spawn(|| {
            assert_eq!(read_text().err(), Some(SurfaceError::WrongThread));
            assert_eq!(write_text("x").err(), Some(SurfaceError::WrongThread));
        })
        .join()
        .unwrap();
    }
}

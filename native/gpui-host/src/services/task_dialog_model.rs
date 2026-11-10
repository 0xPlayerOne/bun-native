//! How a validated message dialog becomes a Windows task dialog or a macOS
//! alert sheet, and how the button pressed maps back to a wire result. Pure
//! data, so it is tested on every platform even though only Windows and macOS
//! show the dialog.

use bun_native_protocol::{MessageDialogOptions, MessageDialogResult};
use bun_native_windows_services::task_dialog_spec::Pressed;
#[cfg(any(windows, test))]
use bun_native_windows_services::task_dialog_spec::TaskDialogSpec;

/// `title` is the window title, `message` the main instruction and `detail`
/// the content. The overlay-only button `kind` never reaches the host.
/// Escape and the close box end the dialog only when the dialog has a cancel
/// button or is dismissible, exactly as on the overlay.
#[cfg(any(windows, test))]
pub(crate) fn spec(options: &MessageDialogOptions) -> TaskDialogSpec {
    TaskDialogSpec {
        title: options.title.clone(),
        instruction: options.message.clone(),
        content: options.detail.clone(),
        buttons: options
            .buttons
            .iter()
            .map(|button| button.label.clone())
            .collect(),
        default_button: options
            .buttons
            .iter()
            .position(|button| button.id == options.default_button)
            .unwrap_or(0),
        cancellable: options.cancel_button.is_some() || options.dismissible,
    }
}

#[cfg(any(target_os = "macos", test))]
/// A sheet has no title bar, so the title is the alert's bold message text
/// and the message and detail are its informative text, a blank line apart.
pub(crate) fn alert_informative(options: &MessageDialogOptions) -> String {
    match &options.detail {
        Some(detail) => format!("{}\n\n{detail}", options.message),
        None => options.message.clone(),
    }
}

#[cfg(any(target_os = "macos", test))]
/// The key that presses each button of a macOS alert, in button order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AlertKey {
    Return,
    Escape,
    None,
}

#[cfg(any(target_os = "macos", test))]
/// Return presses the default button and Escape the cancel button. An
/// `NSAlert` button owns one key, so when the cancel button is also the
/// default it keeps Return and Escape does nothing. A dismissible dialog
/// without a cancel button has no Escape either: a sheet has no close box.
pub(crate) fn alert_keys(options: &MessageDialogOptions) -> Vec<AlertKey> {
    options
        .buttons
        .iter()
        .map(|button| {
            if button.id == options.default_button {
                AlertKey::Return
            } else if options.cancel_button.as_deref() == Some(button.id.as_str()) {
                AlertKey::Escape
            } else {
                AlertKey::None
            }
        })
        .collect()
}

/// A cancellation is the cancel button, else a dismissal. A dialog that was
/// neither never offers cancellation, so a cancel result for it is a failure.
pub(crate) fn result(options: &MessageDialogOptions, pressed: Pressed) -> MessageDialogResult {
    match pressed {
        Pressed::Button(index) => {
            options
                .buttons
                .get(index)
                .map_or(MessageDialogResult::Failed {}, |button| {
                    MessageDialogResult::Button {
                        id: button.id.clone(),
                    }
                })
        }
        Pressed::Cancel => match &options.cancel_button {
            Some(id) => MessageDialogResult::Button { id: id.clone() },
            None if options.dismissible => MessageDialogResult::Dismissed {},
            None => MessageDialogResult::Failed {},
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bun_native_protocol::MessageDialogButton;

    fn options(cancel: Option<&str>, dismissible: bool) -> MessageDialogOptions {
        MessageDialogOptions {
            title: "Title".into(),
            message: "Message".into(),
            detail: Some("Detail".into()),
            buttons: ["save", "discard", "cancel"]
                .into_iter()
                .map(|id| MessageDialogButton {
                    id: id.into(),
                    label: id.to_uppercase(),
                })
                .collect(),
            default_button: "discard".into(),
            cancel_button: cancel.map(str::to_owned),
            dismissible,
        }
    }

    #[test]
    fn the_spec_carries_text_labels_and_the_default_button() {
        let spec = spec(&options(None, false));
        assert_eq!(spec.title, "Title");
        assert_eq!(spec.instruction, "Message");
        assert_eq!(spec.content.as_deref(), Some("Detail"));
        assert_eq!(spec.buttons, ["SAVE", "DISCARD", "CANCEL"]);
        assert_eq!(spec.default_button, 1);
        assert!(spec.validate().is_ok());
    }

    #[test]
    fn cancellation_is_offered_only_with_a_cancel_button_or_dismissal() {
        assert!(!spec(&options(None, false)).cancellable);
        assert!(spec(&options(Some("cancel"), false)).cancellable);
        assert!(spec(&options(None, true)).cancellable);
    }

    #[test]
    fn alert_informative_text_is_the_message_then_the_detail() {
        let mut options = options(None, false);
        assert_eq!(alert_informative(&options), "Message\n\nDetail");
        options.detail = None;
        assert_eq!(alert_informative(&options), "Message");
    }

    #[test]
    fn alert_keys_give_return_to_the_default_and_escape_to_the_cancel_button() {
        assert_eq!(
            alert_keys(&options(Some("cancel"), true)),
            [AlertKey::None, AlertKey::Return, AlertKey::Escape]
        );
        assert_eq!(
            alert_keys(&options(None, true)),
            [AlertKey::None, AlertKey::Return, AlertKey::None]
        );
        // The default keeps Return when it is also the cancel button.
        assert_eq!(
            alert_keys(&options(Some("discard"), false)),
            [AlertKey::None, AlertKey::Return, AlertKey::None]
        );
    }

    #[test]
    fn a_pressed_button_is_reported_by_its_id() {
        assert_eq!(
            result(&options(None, false), Pressed::Button(1)),
            MessageDialogResult::Button {
                id: "discard".into()
            }
        );
        assert_eq!(
            result(&options(None, false), Pressed::Button(9)),
            MessageDialogResult::Failed {}
        );
    }

    #[test]
    fn cancel_is_the_cancel_button_then_dismissal_then_failure() {
        assert_eq!(
            result(&options(Some("cancel"), true), Pressed::Cancel),
            MessageDialogResult::Button {
                id: "cancel".into()
            }
        );
        assert_eq!(
            result(&options(None, true), Pressed::Cancel),
            MessageDialogResult::Dismissed {}
        );
        assert_eq!(
            result(&options(None, false), Pressed::Cancel),
            MessageDialogResult::Failed {}
        );
    }
}

//! The data a Windows task dialog is built from, and how its numeric result
//! maps back to a button. Plain Rust, compiled and tested on every platform.

/// Button `i` gets the id `FIRST_BUTTON_ID + i`. The ids stay clear of the
/// system's `IDOK`..`IDCONTINUE` (1-11) so a custom button is never mistaken
/// for a system result.
pub const FIRST_BUTTON_ID: i32 = 1_000;
/// The result a closed or cancelled task dialog reports (`IDCANCEL`).
pub const CANCEL_ID: i32 = 2;
pub const MAX_BUTTONS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDialogSpec {
    /// The window title.
    pub title: String,
    /// The main instruction (the large first line).
    pub instruction: String,
    /// The content text under the instruction.
    pub content: Option<String>,
    /// Custom button labels, left to right.
    pub buttons: Vec<String>,
    /// Index of the focused button.
    pub default_button: usize,
    /// Escape and the close box end the dialog with `Pressed::Cancel`.
    /// Without it the dialog ignores both.
    pub cancellable: bool,
}

impl TaskDialogSpec {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.buttons.is_empty() || self.buttons.len() > MAX_BUTTONS {
            return Err("a task dialog needs between 1 and 4 buttons");
        }
        if self.default_button >= self.buttons.len() {
            return Err("the default button must be one of the buttons");
        }
        Ok(())
    }

    /// The id of button `index`.
    pub fn button_id(index: usize) -> i32 {
        FIRST_BUTTON_ID + i32::try_from(index).unwrap_or(i32::MAX - FIRST_BUTTON_ID)
    }
}

/// How a task dialog ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pressed {
    /// The button at this index of the spec.
    Button(usize),
    /// Escape or the close box.
    Cancel,
}

/// Map the id `TaskDialogIndirect` returned. `None` is an id this dialog
/// never offered, which the caller reports as a failure.
pub fn pressed(buttons: usize, id: i32) -> Option<Pressed> {
    if id == CANCEL_ID {
        return Some(Pressed::Cancel);
    }
    let index = usize::try_from(id.checked_sub(FIRST_BUTTON_ID)?).ok()?;
    (index < buttons).then_some(Pressed::Button(index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(buttons: usize, default_button: usize) -> TaskDialogSpec {
        TaskDialogSpec {
            title: "Title".into(),
            instruction: "Instruction".into(),
            content: None,
            buttons: (0..buttons).map(|index| format!("B{index}")).collect(),
            default_button,
            cancellable: false,
        }
    }

    #[test]
    fn buttons_are_bounded_and_the_default_is_one_of_them() {
        assert!(spec(1, 0).validate().is_ok());
        assert!(spec(4, 3).validate().is_ok());
        assert!(spec(0, 0).validate().is_err());
        assert!(spec(5, 0).validate().is_err());
        assert!(spec(2, 2).validate().is_err());
    }

    #[test]
    fn results_map_back_to_the_offered_buttons_only() {
        assert_eq!(
            pressed(3, TaskDialogSpec::button_id(0)),
            Some(Pressed::Button(0))
        );
        assert_eq!(
            pressed(3, TaskDialogSpec::button_id(2)),
            Some(Pressed::Button(2))
        );
        assert_eq!(pressed(3, CANCEL_ID), Some(Pressed::Cancel));
        // The system's own ids, an id past the last button, and overflow.
        for id in [0, 1, 6, 999, FIRST_BUTTON_ID + 3, i32::MAX, i32::MIN, -1] {
            assert_eq!(pressed(3, id), None, "{id}");
        }
    }

    #[test]
    fn custom_ids_never_collide_with_system_results() {
        for index in 0..MAX_BUTTONS {
            let id = TaskDialogSpec::button_id(index);
            assert!(id > 11, "{id}");
            assert_ne!(id, CANCEL_ID);
        }
    }
}

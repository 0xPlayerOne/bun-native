//! The data a Windows popup menu is built from. Plain Rust, compiled and
//! tested on every platform.

/// One entry of a validated menu. `command` is the application's item index
/// plus one; `TrackPopupMenuEx` returns it, and 0 means nothing was chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuNode {
    Item {
        command: u32,
        /// The label with any shortcut hint after a tab.
        text: String,
        enabled: bool,
        checked: bool,
    },
    Separator,
    Submenu {
        text: String,
        enabled: bool,
        items: Vec<MenuNode>,
    },
}

/// A literal label: `&` would otherwise mark the next character as the
/// item's access key, so it is doubled.
pub fn menu_text(label: &str, hint: Option<&str>) -> String {
    let mut text = label.replace('&', "&&");
    if let Some(hint) = hint {
        text.push('\t');
        text.push_str(&hint.replace('&', "&&"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_literal_and_hints_follow_a_tab() {
        assert_eq!(menu_text("Cut", None), "Cut");
        assert_eq!(menu_text("Save & Close", None), "Save && Close");
        assert_eq!(menu_text("Copy", Some("Ctrl+C")), "Copy\tCtrl+C");
    }
}

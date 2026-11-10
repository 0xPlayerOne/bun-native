//! How a validated context menu becomes a platform menu tree and how a chosen
//! entry maps back to the application's item id. Pure data, so it is tested
//! on every platform even though only macOS and Windows show the menu.

use bun_native_protocol::{AppMenuEntry, MenuShortcut};

/// Every item id in depth-first order: item `i` is reported as tag `i + 1`.
pub(crate) fn item_ids(items: &[AppMenuEntry]) -> Vec<String> {
    fn walk(items: &[AppMenuEntry], into: &mut Vec<String>) {
        for item in items {
            match item {
                AppMenuEntry::Item { id, .. } => into.push(id.clone()),
                AppMenuEntry::Separator {} => {}
                AppMenuEntry::Submenu { items, .. } => walk(items, into),
            }
        }
    }
    let mut ids = Vec::new();
    walk(items, &mut ids);
    ids
}

/// The application id of a reported tag; anything else is no choice.
pub(crate) fn chosen(ids: &[String], tag: Option<u32>) -> Option<String> {
    let index = usize::try_from(tag?.checked_sub(1)?).ok()?;
    ids.get(index).cloned()
}

/// Walk the entries in the same depth-first order as [`item_ids`], building
/// a platform tree. `item` receives the tag, the entry and the shortcut.
pub(crate) fn map<T>(
    items: &[AppMenuEntry],
    item: &mut impl FnMut(u32, &str, Option<&MenuShortcut>, bool, bool) -> T,
    separator: &impl Fn() -> T,
    submenu: &impl Fn(&str, bool, Vec<T>) -> T,
    next: &mut u32,
) -> Vec<T> {
    items
        .iter()
        .map(|entry| match entry {
            AppMenuEntry::Item {
                label,
                shortcut,
                enabled,
                checked,
                ..
            } => {
                *next += 1;
                item(*next, label, shortcut.as_ref(), *enabled, *checked)
            }
            AppMenuEntry::Separator {} => separator(),
            AppMenuEntry::Submenu {
                label,
                enabled,
                items,
            } => {
                let children = map(items, item, separator, submenu, next);
                submenu(label, *enabled, children)
            }
        })
        .collect()
}

/// The shortcut hint a Windows menu shows after a tab, such as `Ctrl+Shift+S`.
#[cfg(any(windows, test))]
pub(crate) fn windows_hint(shortcut: &MenuShortcut) -> String {
    let modifiers = shortcut.modifiers;
    let mut parts: Vec<String> = [
        (modifiers.control, "Ctrl"),
        (modifiers.alt, "Alt"),
        (modifiers.shift, "Shift"),
        (modifiers.platform, "Win"),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .map(|(_, name)| name.to_owned())
    .collect();
    let key = shortcut.key.as_str();
    parts.push(match key {
        "enter" => "Enter".into(),
        "escape" => "Esc".into(),
        "tab" => "Tab".into(),
        "space" => "Space".into(),
        "backspace" => "Backspace".into(),
        "delete" => "Del".into(),
        "up" => "Up".into(),
        "down" => "Down".into(),
        "left" => "Left".into(),
        "right" => "Right".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" => "PgUp".into(),
        "pagedown" => "PgDn".into(),
        _ => key.to_uppercase(),
    });
    parts.join("+")
}

/// The key equivalent an `NSMenuItem` shows: AppKit's character for the key.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_key_equivalent(key: &str) -> String {
    let function = |offset: u32| char::from_u32(0xF700 + offset).map(String::from);
    let named = match key {
        "enter" => Some("\r".into()),
        "escape" => Some("\u{1b}".into()),
        "tab" => Some("\t".into()),
        "space" => Some(" ".into()),
        "backspace" => Some("\u{8}".into()),
        "delete" => function(0x28),
        "up" => function(0),
        "down" => function(1),
        "left" => function(2),
        "right" => function(3),
        "home" => function(0x29),
        "end" => function(0x2B),
        "pageup" => function(0x2C),
        "pagedown" => function(0x2D),
        _ => key
            .strip_prefix('f')
            .and_then(|number| number.parse::<u32>().ok())
            .filter(|number| (1..=12).contains(number))
            .and_then(|number| function(3 + number)),
    };
    named.unwrap_or_else(|| key.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bun_native_protocol::MenuShortcutModifiers;

    fn item(id: &str) -> AppMenuEntry {
        AppMenuEntry::Item {
            id: id.into(),
            label: id.to_uppercase(),
            shortcut: None,
            enabled: true,
            checked: false,
        }
    }

    fn menu() -> Vec<AppMenuEntry> {
        vec![
            item("cut"),
            AppMenuEntry::Separator {},
            AppMenuEntry::Submenu {
                label: "Share".into(),
                enabled: true,
                items: vec![item("mail"), item("link")],
            },
            item("delete"),
        ]
    }

    #[test]
    fn tags_follow_depth_first_item_order_and_map_back() {
        let ids = item_ids(&menu());
        assert_eq!(ids, ["cut", "mail", "link", "delete"]);
        let mut tags = Vec::new();
        let mut next = 0;
        map(
            &menu(),
            &mut |tag, label, _, _, _| tags.push((tag, label.to_owned())),
            &|| (),
            &|_, _, _| (),
            &mut next,
        );
        assert_eq!(
            tags,
            [
                (1, "CUT".into()),
                (2, "MAIL".into()),
                (3, "LINK".into()),
                (4, "DELETE".into())
            ]
        );
        for (tag, id) in tags.iter().map(|(tag, _)| *tag).zip(&ids) {
            assert_eq!(chosen(&ids, Some(tag)).as_ref(), Some(id));
        }
    }

    #[test]
    fn only_offered_tags_are_a_choice() {
        let ids = item_ids(&menu());
        for tag in [None, Some(0), Some(5), Some(u32::MAX)] {
            assert_eq!(chosen(&ids, tag), None, "{tag:?}");
        }
    }

    fn shortcut(key: &str, control: bool, shift: bool, platform: bool) -> MenuShortcut {
        MenuShortcut {
            key: key.into(),
            modifiers: MenuShortcutModifiers {
                control,
                alt: false,
                shift,
                platform,
            },
        }
    }

    #[test]
    fn windows_hints_name_modifiers_then_the_key() {
        assert_eq!(windows_hint(&shortcut("c", true, false, false)), "Ctrl+C");
        assert_eq!(
            windows_hint(&shortcut("s", true, true, false)),
            "Ctrl+Shift+S"
        );
        assert_eq!(windows_hint(&shortcut("f5", false, false, false)), "F5");
        assert_eq!(
            windows_hint(&shortcut("pagedown", false, false, true)),
            "Win+PgDn"
        );
        assert_eq!(windows_hint(&shortcut(",", true, false, false)), "Ctrl+,");
    }

    #[test]
    fn macos_key_equivalents_use_appkit_characters() {
        assert_eq!(macos_key_equivalent("c"), "c");
        assert_eq!(macos_key_equivalent("enter"), "\r");
        assert_eq!(macos_key_equivalent("up"), "\u{F700}");
        assert_eq!(macos_key_equivalent("f1"), "\u{F704}");
        assert_eq!(macos_key_equivalent("f12"), "\u{F70F}");
        assert_eq!(macos_key_equivalent("delete"), "\u{F728}");
        assert_eq!(macos_key_equivalent("pagedown"), "\u{F72D}");
        assert_eq!(macos_key_equivalent("/"), "/");
    }
}

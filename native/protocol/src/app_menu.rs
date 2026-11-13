//! The application menu bar: a closed, bounded description the host turns into
//! native menus. Items carry an application identifier that comes back in
//! `app_menu_item` events; nothing on the wire names a native action.

use crate::{MAX_APP_MENUS, MAX_APP_MENU_DEPTH, MAX_APP_MENU_ENTRIES, MAX_APP_MENU_LABEL_BYTES};
use serde::{Deserialize, Serialize};

pub const MAX_APP_MENU_ITEM_ID_BYTES: usize = 64;

/// Named keys a menu shortcut may use besides `a`-`z`, `0`-`9`, `f1`-`f12`
/// and the punctuation in [`APP_MENU_PUNCTUATION_KEYS`].
pub const APP_MENU_NAMED_KEYS: [&str; 14] = [
    "enter",
    "escape",
    "tab",
    "space",
    "backspace",
    "delete",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
];
pub const APP_MENU_PUNCTUATION_KEYS: [&str; 11] =
    [",", ".", "/", ";", "'", "[", "]", "-", "=", "`", "\\"];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuShortcutModifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    /// Command on macOS.
    pub platform: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuShortcut {
    pub key: String,
    pub modifiers: MenuShortcutModifiers,
}

fn function_key(key: &str) -> bool {
    matches!(
        key.as_bytes(),
        [b'f', b'1'..=b'9'] | [b'f', b'1', b'0'..=b'2']
    )
}

impl MenuShortcut {
    /// The closed key grammar. Every key except `f1`-`f12` needs control, alt
    /// or platform, so a menu shortcut never consumes plain typing.
    pub fn validate(&self) -> Result<(), &'static str> {
        let key = self.key.as_str();
        let known = matches!(key.as_bytes(), [b'a'..=b'z' | b'0'..=b'9'])
            || function_key(key)
            || APP_MENU_PUNCTUATION_KEYS.contains(&key)
            || APP_MENU_NAMED_KEYS.contains(&key);
        if !known {
            return Err("menu shortcut key is not in the closed key set");
        }
        let modifiers = self.modifiers;
        if !function_key(key) && !(modifiers.control || modifiers.alt || modifiers.platform) {
            return Err("menu shortcut requires control, alt or platform unless it is f1-f12");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AppMenuEntry {
    /// Selecting it reports `id` in an `app_menu_item` event.
    Item {
        id: String,
        label: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::non_null"
        )]
        shortcut: Option<MenuShortcut>,
        enabled: bool,
        checked: bool,
    },
    Separator {},
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<AppMenuEntry>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppMenu {
    pub title: String,
    pub items: Vec<AppMenuEntry>,
}

fn label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_APP_MENU_LABEL_BYTES
        && !value.chars().any(char::is_control)
}

/// `[A-Za-z0-9._:-]`, 1-64 bytes: an application identifier, never a native name.
pub fn validate_app_menu_item_id(id: &str) -> Result<(), &'static str> {
    if !id.is_empty()
        && id.len() <= MAX_APP_MENU_ITEM_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err("menu item id must be 1-64 bytes of letters, digits, '.', '_', ':' or '-'")
    }
}

struct Census<'a> {
    entries: usize,
    ids: Vec<&'a str>,
    shortcuts: Vec<&'a MenuShortcut>,
}

fn entries<'a>(
    items: &'a [AppMenuEntry],
    depth: usize,
    census: &mut Census<'a>,
) -> Result<(), &'static str> {
    if items.is_empty() {
        return Err("a menu or submenu needs at least one entry");
    }
    for item in items {
        census.entries += 1;
        if census.entries > MAX_APP_MENU_ENTRIES {
            return Err("a menu bar holds at most 128 entries");
        }
        match item {
            AppMenuEntry::Item {
                id,
                label: text,
                shortcut,
                ..
            } => {
                validate_app_menu_item_id(id)?;
                if !label(text) {
                    return Err(
                        "menu label must be nonempty, at most 64 bytes, and contain no control characters",
                    );
                }
                if census.ids.contains(&id.as_str()) {
                    return Err("menu item ids must be unique in a menu bar");
                }
                census.ids.push(id);
                if let Some(shortcut) = shortcut {
                    shortcut.validate()?;
                    if census.shortcuts.contains(&shortcut) {
                        return Err("menu shortcuts must be unique in a menu bar");
                    }
                    census.shortcuts.push(shortcut);
                }
            }
            AppMenuEntry::Separator {} => {}
            AppMenuEntry::Submenu {
                label: text, items, ..
            } => {
                if !label(text) {
                    return Err(
                        "menu label must be nonempty, at most 64 bytes, and contain no control characters",
                    );
                }
                if depth >= MAX_APP_MENU_DEPTH {
                    return Err("submenus nest at most two levels below a top-level menu");
                }
                entries(items, depth + 1, census)?;
            }
        }
    }
    Ok(())
}

/// A context menu: the same entries as a menu bar's menu, at most 128 at every
/// depth, unique item ids and shortcuts, and submenus nested at most two
/// levels below the menu itself.
pub fn validate_context_menu(items: &[AppMenuEntry]) -> Result<(), &'static str> {
    entries(
        items,
        1,
        &mut Census {
            entries: 0,
            ids: Vec::new(),
            shortcuts: Vec::new(),
        },
    )
}

/// An empty bar is valid: it removes the application's menus.
pub fn validate_app_menus(menus: &[AppMenu]) -> Result<(), &'static str> {
    if menus.len() > MAX_APP_MENUS {
        return Err("a menu bar holds at most 16 menus");
    }
    let mut census = Census {
        entries: 0,
        ids: Vec::new(),
        shortcuts: Vec::new(),
    };
    for menu in menus {
        if !label(&menu.title) {
            return Err(
                "menu title must be nonempty, at most 64 bytes, and contain no control characters",
            );
        }
        entries(&menu.items, 1, &mut census)?;
    }
    Ok(())
}

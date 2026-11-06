//! The application menu bar. The wire carries a validated, closed description;
//! this module turns it into GPUI menus whose actions hold only an opaque
//! `(menu, item)` pair from a host registry, never an application-supplied
//! action name. Installing a new bar revokes every item of the previous one:
//! a selection that still names it (a queued AppKit callback, a stale key
//! binding) is ignored, never reported.
//!
//! The GPUI calls used here are platform neutral and compile everywhere, but
//! only GPUI's macOS backend installs a visible menu bar (an `NSMenu` main
//! menu). Its Linux and Windows backends only store the menus for the
//! application to draw itself, so the service is advertised on macOS only.

use crate::channel::EventSink;
use bun_native_protocol::{
    AppMenu, AppMenuEntry, AppMenuId, ErrorCode, Event, MenuShortcut, RequestId,
};
use gpui::{Action, App, KeyBinding, KeyBindingContextPredicate, Menu, MenuItem};
use std::cell::RefCell;
use std::rc::Rc;

type Failure = (ErrorCode, &'static str);

/// GPUI installs a native menu bar only on macOS at the pinned revision.
pub(crate) const APP_MENU: bool = cfg!(target_os = "macos");

/// Menu shortcuts dispatch inside an owned window's root context, so a deeper
/// focused control (a text input's copy, cut and paste) keeps its own keys.
const SHORTCUT_CONTEXT: &str = "NativeWindow";

/// The only action an enabled menu item dispatches: an opaque registry slot.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = bun_native, no_json, no_register)]
pub(crate) struct AppMenuAction {
    menu: u64,
    item: u32,
}

/// A disabled item's action. Nothing listens for it, so GPUI's macOS menu
/// validation (`is_action_available`, which AppKit's automatic enabling
/// consults and which overrides `MenuItem::disabled`) keeps the item disabled,
/// and its shortcut, still shown, dispatches nothing. Distinct per slot, so a
/// shortcut is displayed beside its own item only.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = bun_native, no_json, no_register)]
pub(crate) struct DisabledAppMenuAction {
    menu: u64,
    item: u32,
}

/// A GPUI keystroke for a shortcut from the closed wire grammar.
pub(crate) fn keystroke(shortcut: &MenuShortcut) -> String {
    let modifiers = shortcut.modifiers;
    let mut text = String::new();
    for (enabled, name) in [
        (modifiers.control, "ctrl-"),
        (modifiers.alt, "alt-"),
        (modifiers.shift, "shift-"),
        (modifiers.platform, "cmd-"),
    ] {
        if enabled {
            text.push_str(name);
        }
    }
    text.push_str(&shortcut.key);
    text
}

/// One installed bar, built from validated wire data.
pub(crate) struct Built {
    pub(crate) menus: Vec<Menu>,
    pub(crate) shortcuts: Vec<(String, Box<dyn Action>)>,
}

/// Pure ownership state: which bar is current and what its slots name.
#[derive(Default)]
pub(crate) struct Registry {
    last: Option<AppMenuId>,
    current: Option<AppMenuId>,
    items: Vec<String>,
}

impl Registry {
    /// Revokes the previous bar and builds `menus` (validated on the wire)
    /// under `menu_id`. An empty bar leaves nothing current.
    pub(crate) fn replace(
        &mut self,
        menu_id: AppMenuId,
        menus: &[AppMenu],
    ) -> Result<Built, Failure> {
        if self.last.is_some_and(|last| menu_id <= last) {
            return Err((
                ErrorCode::InvalidState,
                "menu bar identities must increase across the session",
            ));
        }
        self.last = Some(menu_id);
        self.items.clear();
        self.current = (!menus.is_empty()).then_some(menu_id);
        let mut built = Built {
            menus: Vec::with_capacity(menus.len()),
            shortcuts: Vec::new(),
        };
        let menu = u64::from(menu_id);
        for entry in menus {
            let items = self.entries(menu, &entry.items, true, &mut built.shortcuts);
            built
                .menus
                .push(Menu::new(entry.title.clone()).items(items));
        }
        Ok(built)
    }

    fn entries(
        &mut self,
        menu: u64,
        entries: &[AppMenuEntry],
        parent_enabled: bool,
        shortcuts: &mut Vec<(String, Box<dyn Action>)>,
    ) -> Vec<MenuItem> {
        entries
            .iter()
            .map(|entry| match entry {
                AppMenuEntry::Item {
                    id,
                    label,
                    shortcut,
                    enabled,
                    checked,
                } => {
                    // At most MAX_APP_MENU_ENTRIES slots: the index fits u32.
                    let item = self.items.len() as u32;
                    self.items.push(id.clone());
                    // AppKit enables a submenu's items regardless of the
                    // submenu, so a disabled submenu disables its items.
                    let enabled = *enabled && parent_enabled;
                    let action: Box<dyn Action> = if enabled {
                        Box::new(AppMenuAction { menu, item })
                    } else {
                        Box::new(DisabledAppMenuAction { menu, item })
                    };
                    if let Some(shortcut) = shortcut {
                        shortcuts.push((keystroke(shortcut), action.boxed_clone()));
                    }
                    MenuItem::Action {
                        name: label.clone().into(),
                        action,
                        os_action: None,
                        checked: *checked,
                        disabled: !enabled,
                    }
                }
                AppMenuEntry::Separator {} => MenuItem::separator(),
                AppMenuEntry::Submenu {
                    label,
                    enabled,
                    items,
                } => MenuItem::submenu(Menu::new(label.clone()).items(self.entries(
                    menu,
                    items,
                    *enabled && parent_enabled,
                    shortcuts,
                )))
                .disabled(!enabled),
            })
            .collect()
    }

    /// The item a live selection names, or `None` for a revoked one.
    pub(crate) fn select(&self, action: &AppMenuAction) -> Option<(AppMenuId, &str)> {
        let current = self.current?;
        if u64::from(current) != action.menu {
            return None;
        }
        let item = self.items.get(action.item as usize)?;
        Some((current, item))
    }

    /// Revokes the current bar. True when one was installed.
    pub(crate) fn revoke(&mut self) -> bool {
        self.items.clear();
        self.current.take().is_some()
    }
}

#[derive(Clone)]
pub(crate) struct AppMenus {
    registry: Rc<RefCell<Registry>>,
}

impl AppMenus {
    pub(crate) fn new(events: EventSink, cx: &mut App) -> Self {
        let registry = Rc::new(RefCell::new(Registry::default()));
        if APP_MENU {
            let selected = registry.clone();
            cx.on_action(move |action: &AppMenuAction, cx| {
                let Some((menu_id, item_id)) = selected
                    .borrow()
                    .select(action)
                    .map(|(menu_id, item_id)| (menu_id, item_id.to_owned()))
                else {
                    return;
                };
                events.ui(
                    |sequence| Event::AppMenuItem {
                        sequence,
                        menu_id,
                        item_id,
                    },
                    cx,
                );
            });
        }
        Self { registry }
    }

    pub(crate) fn available(&self) -> bool {
        APP_MENU
    }

    /// Installs `menus` as the application menu bar, replacing the previous one.
    pub(crate) fn set(
        &self,
        id: RequestId,
        menu_id: AppMenuId,
        menus: &[AppMenu],
        cx: &mut App,
    ) -> Result<Event, Failure> {
        if !APP_MENU {
            return Err((
                ErrorCode::ServiceUnavailable,
                "this native backend has no application menu bar",
            ));
        }
        let built = self.registry.borrow_mut().replace(menu_id, menus)?;
        install(built, cx)?;
        Ok(Event::AppMenuSet { id, menu_id })
    }

    /// Removes an installed bar at shutdown or disconnect.
    pub(crate) fn stop(&self, cx: &mut App) {
        if self.registry.borrow_mut().revoke() {
            let _ = install(
                Built {
                    menus: Vec::new(),
                    shortcuts: Vec::new(),
                },
                cx,
            );
        }
    }
}

/// Rebuilds the keymap so only the current bar's shortcuts are bound, then
/// installs the menus. GPUI reads key equivalents from the keymap when the
/// menus are set, so bindings come first.
fn install(built: Built, cx: &mut App) -> Result<(), Failure> {
    let context = KeyBindingContextPredicate::parse(SHORTCUT_CONTEXT)
        .map_err(|_| (ErrorCode::NativeFailure, "menu shortcut context is invalid"))?;
    let context = Rc::new(context);
    let mut bindings = Vec::with_capacity(built.shortcuts.len());
    for (keystroke, action) in built.shortcuts {
        bindings.push(
            KeyBinding::load(&keystroke, action, Some(context.clone()), false, None, cx)
                .map_err(|_| (ErrorCode::NativeFailure, "menu shortcut was not accepted"))?,
        );
    }
    cx.clear_key_bindings();
    crate::input::bind_keys(cx);
    crate::view::bind_keys(cx);
    cx.bind_keys(bindings);
    cx.set_menus(built.menus);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bun_native_protocol::{
        APP_MENU_NAMED_KEYS, APP_MENU_PUNCTUATION_KEYS, MenuShortcutModifiers,
    };
    use gpui::Keystroke;

    fn id(value: u64) -> AppMenuId {
        AppMenuId::try_from(value).unwrap()
    }

    fn item(id: &str, shortcut: Option<MenuShortcut>) -> AppMenuEntry {
        AppMenuEntry::Item {
            id: id.into(),
            label: id.to_uppercase(),
            shortcut,
            enabled: true,
            checked: false,
        }
    }

    fn command(key: &str) -> Option<MenuShortcut> {
        Some(MenuShortcut {
            key: key.into(),
            modifiers: MenuShortcutModifiers {
                platform: true,
                ..MenuShortcutModifiers::default()
            },
        })
    }

    fn bar() -> Vec<AppMenu> {
        vec![
            AppMenu {
                title: "App".into(),
                items: vec![
                    item("about", None),
                    AppMenuEntry::Separator {},
                    item("quit", command("q")),
                ],
            },
            AppMenu {
                title: "File".into(),
                items: vec![AppMenuEntry::Submenu {
                    label: "Recent".into(),
                    enabled: false,
                    items: vec![
                        AppMenuEntry::Item {
                            id: "recent.1".into(),
                            label: "notes.txt".into(),
                            shortcut: None,
                            enabled: true,
                            checked: true,
                        },
                        item("recent.clear", command("k")),
                    ],
                }],
            },
        ]
    }

    fn action(item: &MenuItem) -> &AppMenuAction {
        match item {
            MenuItem::Action { action, .. } => action.as_any().downcast_ref().unwrap(),
            _ => panic!("not an action"),
        }
    }

    fn disabled(item: &MenuItem) -> &DisabledAppMenuAction {
        match item {
            MenuItem::Action { action, .. } => action.as_any().downcast_ref().unwrap(),
            _ => panic!("not an action"),
        }
    }

    #[test]
    fn a_bar_becomes_gpui_menus_whose_actions_name_only_registry_slots() {
        let mut registry = Registry::default();
        let built = registry.replace(id(1), &bar()).unwrap();
        assert_eq!(built.menus.len(), 2);
        assert_eq!(built.menus[0].name.as_ref(), "App");
        let app = &built.menus[0].items;
        assert!(matches!(app[1], MenuItem::Separator));
        assert_eq!(action(&app[0]), &AppMenuAction { menu: 1, item: 0 });
        assert_eq!(action(&app[2]), &AppMenuAction { menu: 1, item: 1 });
        assert!(matches!(&app[2], MenuItem::Action { name, .. } if name.as_ref() == "QUIT"));
        let MenuItem::Submenu(recent) = &built.menus[1].items[0] else {
            panic!("submenu expected");
        };
        assert!(recent.disabled);
        assert!(matches!(
            &recent.items[0],
            MenuItem::Action { name, checked: true, disabled: true, .. } if name.as_ref() == "notes.txt"
        ));
        // A disabled item (here also under a disabled submenu) dispatches an
        // action nothing listens for, so AppKit's validation keeps it disabled.
        assert_eq!(
            disabled(&recent.items[0]),
            &DisabledAppMenuAction { menu: 1, item: 2 }
        );
        assert_eq!(
            disabled(&recent.items[1]),
            &DisabledAppMenuAction { menu: 1, item: 3 }
        );
        let shortcuts: Vec<_> = built
            .shortcuts
            .iter()
            .map(|(keystroke, _)| keystroke.as_str())
            .collect();
        assert_eq!(shortcuts, ["cmd-q", "cmd-k"]);
        assert!(
            built.shortcuts[0]
                .1
                .partial_eq(&AppMenuAction { menu: 1, item: 1 })
        );
        // A disabled item's shortcut stays visible but binds the inert action.
        assert!(
            built.shortcuts[1]
                .1
                .partial_eq(&DisabledAppMenuAction { menu: 1, item: 3 })
        );
        assert_eq!(
            registry.select(&AppMenuAction { menu: 1, item: 2 }),
            Some((id(1), "recent.1"))
        );
        assert_eq!(registry.select(&AppMenuAction { menu: 1, item: 4 }), None);
    }

    #[test]
    fn replacing_or_clearing_revokes_every_previous_slot() {
        let mut registry = Registry::default();
        registry.replace(id(1), &bar()).unwrap();
        let stale = AppMenuAction { menu: 1, item: 1 };
        assert!(registry.select(&stale).is_some());
        registry
            .replace(
                id(2),
                &[AppMenu {
                    title: "Edit".into(),
                    items: vec![item("undo", command("z"))],
                }],
            )
            .unwrap();
        assert_eq!(registry.select(&stale), None);
        assert_eq!(
            registry.select(&AppMenuAction { menu: 2, item: 0 }),
            Some((id(2), "undo"))
        );
        // Identities only increase; a rejected bar changes nothing.
        for menu_id in [1, 2] {
            assert_eq!(
                registry.replace(id(menu_id), &bar()).err().map(|e| e.0),
                Some(ErrorCode::InvalidState)
            );
        }
        assert!(
            registry
                .select(&AppMenuAction { menu: 2, item: 0 })
                .is_some()
        );
        let cleared = registry.replace(id(3), &[]).unwrap();
        assert!(cleared.menus.is_empty() && cleared.shortcuts.is_empty());
        assert_eq!(registry.select(&AppMenuAction { menu: 2, item: 0 }), None);
        assert_eq!(registry.select(&AppMenuAction { menu: 3, item: 0 }), None);
        assert!(!registry.revoke());
        registry.replace(id(4), &bar()).unwrap();
        assert!(registry.revoke());
        assert_eq!(registry.select(&AppMenuAction { menu: 4, item: 0 }), None);
    }

    #[test]
    fn every_shortcut_in_the_closed_grammar_is_a_gpui_keystroke() {
        let keys = ('a'..='z')
            .chain('0'..='9')
            .map(String::from)
            .chain((1..=12).map(|n| format!("f{n}")))
            .chain(APP_MENU_PUNCTUATION_KEYS.iter().map(|key| key.to_string()))
            .chain(APP_MENU_NAMED_KEYS.iter().map(|key| key.to_string()));
        for key in keys {
            for bits in 0..16u8 {
                let modifiers = MenuShortcutModifiers {
                    control: bits & 1 != 0,
                    alt: bits & 2 != 0,
                    shift: bits & 4 != 0,
                    platform: bits & 8 != 0,
                };
                let shortcut = MenuShortcut {
                    key: key.clone(),
                    modifiers,
                };
                let text = keystroke(&shortcut);
                let parsed = Keystroke::parse(Box::leak(text.clone().into_boxed_str()))
                    .unwrap_or_else(|_| panic!("{text}"));
                assert_eq!(parsed.key, key, "{text}");
                assert_eq!(parsed.modifiers.control, modifiers.control, "{text}");
                assert_eq!(parsed.modifiers.alt, modifiers.alt, "{text}");
                assert_eq!(parsed.modifiers.shift, modifiers.shift, "{text}");
                assert_eq!(parsed.modifiers.platform, modifiers.platform, "{text}");
                assert!(!parsed.modifiers.function, "{text}");
            }
        }
    }

    #[test]
    fn the_service_is_advertised_only_where_gpui_shows_a_menu_bar() {
        assert_eq!(APP_MENU, cfg!(target_os = "macos"));
    }
}

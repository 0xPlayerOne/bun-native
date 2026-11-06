//! Menu bar wire bounds are headless; the native macOS run is separate.

use crate::{
    validate_app_menus, write_event, AppMenu, AppMenuEntry, AppMenuId, Command, MenuShortcut,
    MenuShortcutModifiers, RequestId, ServicePolicy, APP_MENU_NAMED_KEYS,
    APP_MENU_PUNCTUATION_KEYS, MAX_APP_MENUS, MAX_APP_MENU_ENTRIES, MAX_APP_MENU_ITEM_ID_BYTES,
    MAX_APP_MENU_LABEL_BYTES, MAX_FRAME_BYTES,
};

#[test]
fn app_menu_grant_is_optional_on_the_wire_and_absent_when_denied() {
    let existing = serde_json::json!({
        "window_display": false,
        "clipboard_read": false,
        "clipboard_write": false,
        "global_shortcuts": false,
        "notifications": false,
        "drag_drop": false,
        "filesystem_roots": [],
        "processes": [],
    });
    let policy: ServicePolicy = serde_json::from_value(existing.clone()).unwrap();
    assert!(!policy.app_menu);
    assert_eq!(serde_json::to_value(policy).unwrap(), existing);
    let granted = ServicePolicy {
        app_menu: true,
        ..ServicePolicy::default()
    };
    let wire = serde_json::to_value(&granted).unwrap();
    assert_eq!(wire["app_menu"], true);
    assert_eq!(
        serde_json::from_value::<ServicePolicy>(wire).unwrap(),
        granted
    );
    for value in [serde_json::Value::Null, 1.into(), "allow".into()] {
        let mut wire = existing.clone();
        wire["app_menu"] = value;
        assert!(serde_json::from_value::<ServicePolicy>(wire).is_err());
    }
}

fn worst_case_item(index: usize) -> AppMenuEntry {
    // `"` doubles under JSON escaping; ids are ASCII by grammar.
    let id = format!("{index:0>width$}", width = MAX_APP_MENU_ITEM_ID_BYTES);
    AppMenuEntry::Item {
        id,
        label: "\"".repeat(MAX_APP_MENU_LABEL_BYTES),
        shortcut: None,
        enabled: true,
        checked: false,
    }
}

/// Bounds are chosen so the largest valid bar always fits one frame.
#[test]
fn the_largest_valid_menu_bar_fits_one_frame() {
    let per_menu = MAX_APP_MENU_ENTRIES / MAX_APP_MENUS;
    let menus: Vec<AppMenu> = (0..MAX_APP_MENUS)
        .map(|menu| AppMenu {
            title: "\"".repeat(MAX_APP_MENU_LABEL_BYTES),
            items: (0..per_menu)
                .map(|item| {
                    let mut entry = worst_case_item(menu * per_menu + item);
                    if let AppMenuEntry::Item { shortcut, .. } = &mut entry {
                        let keys: Vec<&str> = APP_MENU_NAMED_KEYS
                            .iter()
                            .chain(APP_MENU_PUNCTUATION_KEYS.iter())
                            .copied()
                            .collect();
                        let key = keys[(menu * per_menu + item) % keys.len()];
                        let index = (menu * per_menu + item) / keys.len();
                        *shortcut = Some(MenuShortcut {
                            key: key.into(),
                            modifiers: MenuShortcutModifiers {
                                control: index & 1 != 0,
                                alt: index & 2 != 0,
                                shift: index & 4 != 0,
                                platform: true,
                            },
                        });
                    }
                    entry
                })
                .collect(),
        })
        .collect();
    validate_app_menus(&menus).unwrap();
    let command = Command::SetAppMenu {
        id: RequestId::try_from(u64::MAX >> 11).unwrap(),
        menu_id: AppMenuId::try_from(u64::MAX >> 11).unwrap(),
        menus,
    };
    assert!(command.validate().is_ok());
    let bytes = serde_json::to_vec(&command).unwrap();
    assert!(bytes.len() < MAX_FRAME_BYTES, "{}", bytes.len());
}

#[test]
fn app_menu_events_round_trip_and_are_bounded() {
    let event = crate::Event::AppMenuItem {
        sequence: crate::EventSequence::try_from(1).unwrap(),
        menu_id: AppMenuId::try_from(2).unwrap(),
        item_id: "a".repeat(MAX_APP_MENU_ITEM_ID_BYTES),
    };
    assert!(event.validate().is_ok());
    let mut bytes = Vec::new();
    write_event(&mut bytes, &event).unwrap();
    let invalid = crate::Event::AppMenuItem {
        sequence: crate::EventSequence::try_from(1).unwrap(),
        menu_id: AppMenuId::try_from(2).unwrap(),
        item_id: "a".repeat(MAX_APP_MENU_ITEM_ID_BYTES + 1),
    };
    assert!(invalid.validate().is_err());
}

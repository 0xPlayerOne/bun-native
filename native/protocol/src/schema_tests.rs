//! The derived serde types against the generated schema tables. Commands,
//! events, key modifiers and the nested payload objects keep hand-written
//! serde types; these tests read back the member and variant names serde
//! itself reports and compare them with `packages/protocol/schema/wire.json`,
//! so neither side can drift.

use crate::wire::{
    COMMAND_MEMBERS, EVENT_MEMBERS, MODIFIER_MEMBERS, PAYLOAD_MEMBERS, TAGGED_PAYLOAD_MEMBERS,
};
use crate::*;
use serde::de::DeserializeOwned;
use std::collections::BTreeSet;

/// A member name no message defines.
const PROBE: &str = "__schema_probe";

/// The backticked names after "expected" in a serde `unknown field` or
/// `unknown variant` error; none when serde reports "there are no fields".
fn expected(error: &str) -> BTreeSet<String> {
    if error.contains("there are no fields") {
        return BTreeSet::new();
    }
    let (_, list) = error
        .split_once("expected")
        .unwrap_or_else(|| panic!("no expected names in {error}"));
    list.split('`')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

fn rejection<T: DeserializeOwned + std::fmt::Debug>(json: &str) -> String {
    serde_json::from_str::<T>(json)
        .expect_err("the probe must be rejected")
        .to_string()
}

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|name| (*name).to_owned()).collect()
}

/// Checks a tagged type's variant tags and each variant's members, the tag excluded.
pub(crate) fn check_tagged<T: DeserializeOwned + std::fmt::Debug>(
    tag: &str,
    table: &[(&str, &[&str])],
) {
    let variants = rejection::<T>(&format!(r#"{{"{tag}":"{PROBE}"}}"#));
    assert!(variants.contains("unknown variant"), "{variants}");
    assert_eq!(
        expected(&variants),
        table.iter().map(|(tag, _)| (*tag).to_owned()).collect(),
        "variant tags"
    );
    for (variant, members) in table {
        let error = rejection::<T>(&format!(r#"{{"{tag}":"{variant}","{PROBE}":0}}"#));
        assert!(error.contains("unknown field"), "{variant}: {error}");
        assert_eq!(expected(&error), names(members), "members of {variant}");
    }
}

fn check_plain<T: DeserializeOwned + std::fmt::Debug>(members: &[&str]) {
    let error = rejection::<T>(&format!(r#"{{"{PROBE}":0}}"#));
    assert!(error.contains("unknown field"), "{error}");
    assert_eq!(expected(&error), names(members));
}

#[test]
fn commands_match_the_schema() {
    check_tagged::<Command>("type", COMMAND_MEMBERS);
}

#[test]
fn events_match_the_schema() {
    check_tagged::<Event>("type", EVENT_MEMBERS);
}

#[test]
fn key_modifiers_match_the_schema() {
    let error = rejection::<KeyModifiers>(&format!(r#"{{"{PROBE}":true}}"#));
    assert_eq!(expected(&error), names(MODIFIER_MEMBERS));
}

/// Every payload in the schema, checked against its serde type. A payload added
/// to the schema without a line here fails `every_payload_is_checked`.
fn check_payload(name: &str) -> bool {
    let plain = PAYLOAD_MEMBERS.iter().find(|(payload, _)| *payload == name);
    let tagged = TAGGED_PAYLOAD_MEMBERS
        .iter()
        .find(|(payload, _, _)| *payload == name);
    macro_rules! plain {
        ($($payload:literal => $type:ty),* $(,)?) => {
            match name {
                $($payload => check_plain::<$type>(plain.expect($payload).1),)*
                _ => return false,
            }
        };
    }
    macro_rules! tagged {
        ($($payload:literal => $type:ty),* $(,)?) => {
            match name {
                $($payload => {
                    let (_, tag, variants) = tagged.expect($payload);
                    check_tagged::<$type>(tag, variants)
                })*
                _ => return false,
            }
        };
    }
    if plain.is_some() {
        plain! {
            "filesystem_root" => FilesystemRoot,
            "directory_entry" => DirectoryEntry,
            "process_limits" => ProcessLimits,
            "process_executable" => ProcessExecutable,
            "process_launch" => ProcessLaunch,
            "process_directory" => ProcessDirectory,
            "terminal_size" => TerminalSize,
            "process_exit" => ProcessExit,
            "app_menu" => AppMenu,
            "menu_shortcut" => MenuShortcut,
            "menu_shortcut_modifiers" => MenuShortcutModifiers,
            "file_dialog_options" => FileDialogOptions,
            "file_filter" => FileFilter,
            "message_dialog_options" => MessageDialogOptions,
            "message_dialog_button" => MessageDialogButton,
            "service_policy" => ServicePolicy,
            "shortcut_modifiers" => ShortcutModifiers,
            "display_snapshot" => DisplaySnapshot,
            "display_bounds" => DisplayBounds,
            "dropped_item" => DroppedItem,
        }
    } else {
        tagged! {
            "file_operation" => FileOperation,
            "file_result" => FileResult,
            "app_menu_entry" => AppMenuEntry,
            "file_dialog_result" => FileDialogResult,
            "message_dialog_result" => MessageDialogResult,
            "clipboard_text" => ClipboardText,
        }
    }
    true
}

#[test]
fn every_payload_is_checked() {
    let all = PAYLOAD_MEMBERS
        .iter()
        .map(|(name, _)| *name)
        .chain(TAGGED_PAYLOAD_MEMBERS.iter().map(|(name, _, _)| *name));
    for name in all {
        assert!(
            check_payload(name),
            "payload {name} has no serde type check"
        );
    }
}

#[test]
fn expected_names_follow_serde_spellings() {
    assert_eq!(
        expected("unknown field `x`, expected `a` or `b` at line 1"),
        names(&["a", "b"])
    );
    assert_eq!(expected("unknown field `x`, expected `a`"), names(&["a"]));
    assert_eq!(
        expected("unknown field `x`, there are no fields"),
        names(&[])
    );
}

//! The derived serde types against the generated schema tables. Commands,
//! events and key modifiers keep hand-written serde types; these tests read
//! back the member and variant names serde itself reports and compare them
//! with `packages/protocol/schema/wire.json`, so neither side can drift.

use crate::wire::{COMMAND_MEMBERS, EVENT_MEMBERS, MODIFIER_MEMBERS};
use crate::{Command, Event, KeyModifiers};
use serde::de::DeserializeOwned;
use std::collections::BTreeSet;

/// A member name no message defines.
const PROBE: &str = "__schema_probe";

/// The backticked names after "expected" in a serde `unknown field` or
/// `unknown variant` error.
fn expected(error: &str) -> BTreeSet<String> {
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

fn check_tagged<T: DeserializeOwned + std::fmt::Debug>(table: &[(&str, &[&str])]) {
    let variants = rejection::<T>(&format!(r#"{{"type":"{PROBE}"}}"#));
    assert!(variants.contains("unknown variant"), "{variants}");
    assert_eq!(
        expected(&variants),
        table.iter().map(|(tag, _)| (*tag).to_owned()).collect(),
        "variant tags"
    );
    for (tag, members) in table {
        let error = rejection::<T>(&format!(r#"{{"type":"{tag}","{PROBE}":0}}"#));
        assert!(error.contains("unknown field"), "{tag}: {error}");
        assert_eq!(expected(&error), names(members), "members of {tag}");
    }
}

#[test]
fn commands_match_the_schema() {
    check_tagged::<Command>(COMMAND_MEMBERS);
}

#[test]
fn events_match_the_schema() {
    check_tagged::<Event>(EVENT_MEMBERS);
}

#[test]
fn key_modifiers_match_the_schema() {
    let error = rejection::<KeyModifiers>(&format!(r#"{{"{PROBE}":true}}"#));
    assert_eq!(expected(&error), names(MODIFIER_MEMBERS));
}

#[test]
fn expected_names_follow_serde_spellings() {
    assert_eq!(
        expected("unknown field `x`, expected `a` or `b` at line 1"),
        names(&["a", "b"])
    );
    assert_eq!(expected("unknown field `x`, expected `a`"), names(&["a"]));
}

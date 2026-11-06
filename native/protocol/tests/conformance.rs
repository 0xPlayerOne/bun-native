//! Shared command and event wire conformance with the TypeScript validators
//! (tests/protocol/conformance.test.ts). `expect` is the contract; a case with
//! `knownDivergence` names the side that currently does the opposite, and both
//! suites assert that divergence explicitly. Decoding only: no session state.

use bun_native_protocol::{CommandReader, Event, PROTOCOL_VERSION};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::io::Cursor;
use std::path::Path;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixtures {
    protocol: u32,
    scope: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Case {
    name: String,
    category: String,
    direction: Direction,
    frame: String,
    expect: Outcome,
    known_divergence: Option<String>,
    divergent_side: Option<Side>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Direction {
    Command,
    Event,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Accept,
    Reject,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Side {
    Rust,
    Typescript,
}

fn fixtures() -> Fixtures {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("protocol-conformance.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).expect("valid shared conformance fixtures")
}

fn decode_command(frame: &str) -> Outcome {
    let bytes = format!("{frame}\n");
    let mut source = Cursor::new(bytes.as_bytes());
    match CommandReader::default().read(&mut source) {
        Ok(Some(_)) => Outcome::Accept,
        _ => Outcome::Reject,
    }
}

/// The native side writes events; this is the same check `write_event` applies
/// after the typed decode a reader of native output would perform.
fn decode_event(frame: &str) -> Outcome {
    let parsed =
        serde_json::from_str::<serde_json::Value>(frame).and_then(serde_json::from_value::<Event>);
    match parsed {
        Ok(event) if event.validate().is_ok() => Outcome::Accept,
        _ => Outcome::Reject,
    }
}

#[test]
fn shared_conformance_fixtures_match_typescript() {
    let fixtures = fixtures();
    assert_eq!(fixtures.protocol, PROTOCOL_VERSION);
    assert!(!fixtures.scope.is_empty());
    let mut names = BTreeSet::new();
    let mut failures = Vec::new();
    for case in fixtures.cases {
        assert!(names.insert(case.name.clone()), "duplicate {}", case.name);
        assert!(!case.category.is_empty(), "{}: missing category", case.name);
        assert_eq!(
            case.known_divergence.is_some(),
            case.divergent_side.is_some(),
            "{}: knownDivergence and divergentSide go together",
            case.name
        );
        let expected = match (case.divergent_side, case.expect) {
            (Some(Side::Rust), Outcome::Accept) => Outcome::Reject,
            (Some(Side::Rust), Outcome::Reject) => Outcome::Accept,
            (Some(Side::Typescript) | None, outcome) => outcome,
        };
        let actual = match case.direction {
            Direction::Command => decode_command(&case.frame),
            Direction::Event => decode_event(&case.frame),
        };
        if actual != expected {
            failures.push(format!(
                "{}: expected {expected:?}, got {actual:?}",
                case.name
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

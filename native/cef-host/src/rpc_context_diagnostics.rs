//! Contributor-only evidence, not an authenticator or a page-visible API.
//! No payloads, URLs, connection/generation credentials or raw pointers are logged.
use super::{snapshot, Context, Identity};
use cef::*;
use serde_json::{json, Value};
use std::cell::Cell;

thread_local! { static RECORDS: Cell<u8> = const { Cell::new(0) }; }
const MAX_RECORDS: u8 = 32;

fn context(value: Option<&V8Context>, bound: Option<&Context>) -> Value {
    let Some(value) = value.filter(|value| value.is_valid() != 0) else {
        return json!({"valid":false});
    };
    let frame = value.frame();
    json!({
        "valid": true,
        "browser": value.browser().map(|browser| browser.identifier()),
        "frame": frame.as_ref().map(|frame| CefString::from(&frame.identifier()).to_string().chars().take(128).collect::<String>()),
        "main": frame.as_ref().is_some_and(|frame| frame.is_valid() != 0 && frame.is_main() != 0),
        "matchesBoundContext": bound.is_some_and(|bound| {
            bound.context.is_valid() != 0 && bound.context.is_same(Some(&mut value.clone())) != 0
        }),
    })
}

pub(super) fn begin(browser: i32, identity: Identity, operation: &str) -> Option<Value> {
    let admitted = RECORDS.with(|records| {
        let count = records.get();
        if count >= MAX_RECORDS {
            return false;
        }
        records.set(count + 1);
        true
    });
    if !admitted {
        return None;
    }
    // Snapshot ends the registry borrow before any CEF getter is invoked.
    let bound = snapshot(browser);
    let current = v8_context_get_current_context();
    let entered = v8_context_get_entered_context();
    Some(json!({
        "event": "bunly.rpc.context-diagnostic",
        "schema": 1,
        "operation": operation,
        "boundRegistryPresent": bound.is_some(),
        "bindingMatchesHandler": bound.as_ref().is_some_and(|bound| bound.identity == Some(identity)),
        "bound": context(bound.as_ref().map(|bound| &bound.context), bound.as_ref()),
        "current": context(current.as_ref(), bound.as_ref()),
        "entered": context(entered.as_ref(), bound.as_ref()),
    }))
}

pub(super) fn finish(record: Option<Value>, outcome: Result<(), &str>, exception_written: bool) {
    let Some(mut record) = record else {
        return;
    };
    record["nativeOutcome"] = json!(if outcome.is_ok() {
        "accepted"
    } else {
        "rejected"
    });
    record["reason"] = json!(outcome.err());
    record["exceptionWritten"] = json!(exception_written);
    let line = record.to_string();
    if line.len() <= 2048 {
        eprintln!("{line}");
    }
}

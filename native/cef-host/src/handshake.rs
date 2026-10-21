//! Private inherited-pipe negotiation; contains no CEF/native-view operations.
use serde_json::Value;

#[derive(Default)]
pub(crate) struct Handshake {
    completed: bool,
}
impl Handshake {
    /// Return true only for the first validated hello. Later application commands
    /// still go through the bounded CEF UI queue; a repeated hello is not a reset.
    pub(crate) fn accept(&mut self, frame: &Value) -> Result<bool, &'static str> {
        let hello = frame.get("op").and_then(Value::as_str) == Some("hello");
        if self.completed {
            return if hello {
                Err("Duplicate Bun handshake")
            } else {
                Ok(false)
            };
        }
        if !hello || frame.get("id").and_then(Value::as_u64) != Some(1) {
            return Err("First application request must be the Bun handshake");
        }
        let args = frame
            .get("args")
            .and_then(Value::as_object)
            .ok_or("Invalid Bun handshake arguments")?;
        if args.len() != 1 || args.get("bun").and_then(Value::as_str) != Some("1.4.3") {
            return Err("Packaged Bun version mismatch");
        }
        self.completed = true;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn negotiation_requires_the_exact_first_message_and_version() {
        for value in [
            json!({"id":1,"op":"window.create","args":{}}),
            json!({"id":2,"op":"hello","args":{"bun":"1.4.3"}}),
            json!({"id":1,"op":"hello","args":null}),
            json!({"id":1,"op":"hello","args":{"bun":"1.4.0"}}),
            json!({"id":1,"op":"hello","args":{"bun":"1.4.3","extra":true}}),
        ] {
            assert!(Handshake::default().accept(&value).is_err());
        }
    }
    #[test]
    fn valid_handshake_needs_no_gui_dispatch_and_cannot_be_replayed() {
        let mut state = Handshake::default();
        assert_eq!(
            state.accept(&json!({"id":1,"op":"hello","args":{"bun":"1.4.3"}})),
            Ok(true)
        );
        assert_eq!(
            state.accept(&json!({"id":2,"op":"window.create","args":{}})),
            Ok(false)
        );
        assert_eq!(
            state.accept(&json!({"id":3,"op":"hello","args":{"bun":"1.4.3"}})),
            Err("Duplicate Bun handshake")
        );
    }
    #[test]
    fn failed_negotiation_does_not_mark_the_connection_ready() {
        let mut state = Handshake::default();
        assert!(state
            .accept(&json!({"id":1,"op":"hello","args":{"bun":"bad"}}))
            .is_err());
        assert!(state
            .accept(&json!({"id":2,"op":"session.create","args":{}}))
            .is_err());
    }
}

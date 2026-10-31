//! Opt-in native paint instrumentation for the OS-input test harness.
//! A paint callback is not proof of display presentation; screenshots are separate.

use serde_json::json;
use std::cell::RefCell;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::rc::Rc;

#[derive(Clone, Default)]
pub(crate) struct Evidence(Option<Rc<RefCell<Log>>>);

struct Log {
    file: File,
    nonce: String,
    last_state: Option<(String, String)>,
}

fn append(file: &mut File, record: &serde_json::Value) -> std::io::Result<()> {
    let mut line = record.to_string();
    line.push('\n');
    // Bun also appends to this file. Keep each record in one append operation.
    file.write_all(line.as_bytes())?;
    file.flush()
}

impl Evidence {
    pub(crate) fn renderer(&self, gpu: Option<gpui::GpuSpecs>) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let record = json!({"nonce": log.nonce, "type": "renderer", "gpu": gpu});
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native renderer evidence could not be written: {error}");
        }
    }

    pub(crate) fn from_environment() -> Self {
        let (Ok(path), Ok(nonce)) = (
            std::env::var("BUN_NATIVE_EVIDENCE_LOG"),
            std::env::var("BUN_NATIVE_EVIDENCE_NONCE"),
        ) else {
            return Self::default();
        };
        if nonce.is_empty() || nonce.len() > 128 {
            return Self::default();
        }
        match OpenOptions::new().create(true).append(true).open(path) {
            Ok(file) => Self(Some(Rc::new(RefCell::new(Log {
                file,
                nonce,
                last_state: None,
            })))),
            Err(error) => {
                eprintln!("Bun Native native evidence log unavailable: {error}");
                Self::default()
            }
        }
    }

    pub(crate) fn painted(&self, text: &str, input: &str) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        if log
            .last_state
            .as_ref()
            .is_some_and(|state| state.0 == text && state.1 == input)
        {
            return;
        }
        let record = json!({"nonce": log.nonce, "type": "rendered", "text": text, "input": input, "stage": "native-paint"});
        if append(&mut log.file, &record).is_ok() {
            log.last_state = Some((text.to_owned(), input.to_owned()));
        }
    }
}

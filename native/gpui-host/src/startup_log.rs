//! Best-effort, opt-in capture of existing pinned GPUI startup log points.
//! This is diagnostic I/O, not a startup timer or a replacement protocol channel.

use log::{Level, LevelFilter, Log, Metadata, Record};
use serde_json::{Value, json};
use std::fmt::{self, Write as _};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_RECORDS: usize = 64;
const MAX_RECORD_BYTES: usize = 2048;
const MAX_TOTAL_BYTES: usize = 65_536;
const MAX_MESSAGE_BYTES: usize = 512;
const TARGETS: [&str; 3] = [
    "gpui_linux::linux::x11::window",
    "gpui_wgpu::wgpu_context",
    "gpui_wgpu::wgpu_renderer",
];
static LOGGER: OnceLock<StartupLog> = OnceLock::new();

struct Configuration {
    path: PathBuf,
    correlation_id: String,
}

impl Configuration {
    fn parse(flag: &str, trace: &str, path: &str, correlation_id: &str) -> Option<Self> {
        if flag != "1"
            || trace != "1"
            || !PathBuf::from(path).is_absolute()
            || correlation_id.is_empty()
            || correlation_id.len() > 128
            || correlation_id.chars().any(char::is_control)
        {
            return None;
        }
        Some(Self {
            path: path.into(),
            correlation_id: correlation_id.into(),
        })
    }
}

pub(crate) fn install_from_environment() {
    if std::env::var("BUN_NATIVE_STARTUP_LOG").as_deref() != Ok("1") {
        return;
    }
    let configuration = Configuration::parse(
        "1",
        &std::env::var("BUN_NATIVE_STARTUP_TRACE").unwrap_or_default(),
        &std::env::var("BUN_NATIVE_EVIDENCE_LOG").unwrap_or_default(),
        &std::env::var("BUN_NATIVE_EVIDENCE_NONCE").unwrap_or_default(),
    );
    let Some(configuration) = configuration else {
        return;
    };
    let Ok(file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(configuration.path)
    else {
        report_error();
        return;
    };
    if LOGGER
        .set(StartupLog(Mutex::new(Output::new(
            file,
            configuration.correlation_id,
        ))))
        .is_err()
    {
        report_error();
        return;
    }
    let Some(logger) = LOGGER.get() else {
        return;
    };
    if log::set_logger(logger).is_err() {
        if let Ok(mut output) = logger.0.lock() {
            output.sink = None;
        }
        report_error();
        return;
    }
    log::set_max_level(LevelFilter::Info);
    if let Ok(mut output) = logger.0.lock()
        && output
            .emit(json!({
                "phase": "logger_installed", "targets": TARGETS,
                "maximum_level": "INFO", "max_records": MAX_RECORDS,
                "max_record_bytes": MAX_RECORD_BYTES, "max_total_bytes": MAX_TOTAL_BYTES,
                "max_message_bytes": MAX_MESSAGE_BYTES,
            }))
            .is_err()
    {
        report_error();
    }
}

fn report_error() {
    // A broken stderr must not turn a diagnostic failure into a host panic.
    let _ = writeln!(io::stderr().lock(), "Bun Native startup logger unavailable");
}

fn allowed(metadata: &Metadata<'_>) -> bool {
    metadata.level() <= Level::Info && TARGETS.contains(&metadata.target())
}

struct StartupLog(Mutex<Output<File>>);

impl Log for StartupLog {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        allowed(metadata)
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if let Ok(mut output) = self.0.lock()
            && output.record(record).is_err()
        {
            report_error();
        }
    }

    fn flush(&self) {} // Each bounded append already flushes its file handle.
}

struct Output<W> {
    sink: Option<W>,
    // Synthetic run correlation only; never a key, cryptographic nonce or grant.
    correlation_id: String,
    started: Instant,
    records: usize,
    bytes: usize,
}

impl<W: Write> Output<W> {
    fn new(sink: W, correlation_id: String) -> Self {
        Self {
            sink: Some(sink),
            correlation_id,
            started: Instant::now(),
            records: 0,
            bytes: 0,
        }
    }

    fn record(&mut self, record: &Record<'_>) -> io::Result<()> {
        if self.sink.is_none() || !allowed(record.metadata()) {
            return Ok(());
        }
        let mut message = BoundedMessage::default();
        let formatting = write!(message, "{}", record.args());
        self.emit(json!({
            "phase": "log", "target": record.target(), "level": record.level().as_str(),
            "line": record.line(), "message": message.text,
            "truncated": message.truncated,
            "format_error": formatting.is_err() && !message.truncated,
        }))
    }

    fn emit(&mut self, mut record: Value) -> io::Result<()> {
        if self.sink.is_none() {
            return Ok(());
        }
        let mut terminal = self.records + 1 >= MAX_RECORDS;
        if terminal {
            record = json!({"phase": "record_limit"});
        }
        self.header(&mut record);
        let mut line = self.encode_or_disable(&mut record)?;
        // Reserve one complete record for a visible terminal indication.
        if !terminal && self.bytes + line.len() + MAX_RECORD_BYTES > MAX_TOTAL_BYTES {
            terminal = true;
            record = json!({"phase": "byte_limit"});
            self.header(&mut record);
            line = self.encode_or_disable(&mut record)?;
        }
        let result = if let Some(sink) = self.sink.as_mut() {
            sink.write_all(line.as_bytes()).and_then(|()| sink.flush())
        } else {
            Ok(())
        };
        self.records += 1;
        self.bytes += line.len();
        if terminal || result.is_err() {
            self.sink = None;
        }
        result
    }

    fn encode_or_disable(&mut self, record: &mut Value) -> io::Result<String> {
        let result = encode(record);
        if result.is_err() {
            self.sink = None;
        }
        result
    }

    fn header(&self, record: &mut Value) {
        record["nonce"] = json!(self.correlation_id);
        record["stage"] = json!("startup-log");
        record["source"] = json!("native-log");
        record["pid"] = json!(std::process::id());
        record["clock"] = json!("process_monotonic_relative");
        record["elapsed_ns"] = json!(self.started.elapsed().as_nanos().to_string());
        record["index"] = json!(self.records + 1);
    }
}

#[derive(Default)]
struct BoundedMessage {
    text: String,
    truncated: bool,
}

impl fmt::Write for BoundedMessage {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let mut length = value.len().min(MAX_MESSAGE_BYTES - self.text.len());
        while !value.is_char_boundary(length) {
            length -= 1;
        }
        self.text.push_str(&value[..length]);
        if length < value.len() {
            self.truncated = true;
            Err(fmt::Error)
        } else {
            Ok(())
        }
    }
}

fn encode(record: &mut Value) -> io::Result<String> {
    // Every variable field is already bounded. JSON escaping can expand the
    // message; retain an explicit omission instead of emitting an oversized line.
    let mut line = record.to_string();
    if line.len() + 1 > MAX_RECORD_BYTES {
        record["message"] = json!("[message omitted: JSON record limit]");
        record["truncated"] = json!(true);
        line = record.to_string();
    }
    if line.len() + 1 > MAX_RECORD_BYTES {
        return Err(io::Error::other(
            "startup log metadata exceeds record limit",
        ));
    }
    line.push('\n');
    Ok(line)
}

#[cfg(test)]
mod tests;

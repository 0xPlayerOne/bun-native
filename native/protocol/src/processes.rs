//! Owned child processes. The executable is an immutable launch-policy entry;
//! arguments and environment are explicit arrays and maps, never a command
//! string, and a working directory comes only from a live file grant.

use crate::{validate_chunk, validate_file_path, FileGrantId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_PROCESS_EXECUTABLES: usize = 8;
pub const MAX_PROCESSES: usize = 8;
pub const MAX_PROCESS_ARGS: usize = 64;
pub const MAX_PROCESS_ARG_BYTES: usize = 4_096;
pub const MAX_PROCESS_ENV: usize = 64;
pub const MAX_PROCESS_ENV_NAME_BYTES: usize = 128;
pub const MAX_PROCESS_ENV_VALUE_BYTES: usize = 4_096;
/// Combined bytes of arguments and environment, well below the frame cap.
pub const MAX_PROCESS_LAUNCH_BYTES: usize = 32_768;
/// Output chunks a process may have delivered but not yet acknowledged.
pub const MAX_PROCESS_OUTPUT_CREDIT: usize = 4;
pub const MAX_TERMINAL_DIMENSION: u16 = 1_000;

/// One executable the trusted application named at native process launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessExecutable {
    pub id: String,
    pub executable: String,
}

impl ProcessExecutable {
    pub fn validate(&self) -> Result<(), &'static str> {
        crate::validate_root_id(&self.id)
            .map_err(|_| "process executable ID must be 1-32 lowercase ASCII letters, digits, '-' or '_', starting with a letter")?;
        crate::validate_root_path(&self.executable)
            .map_err(|_| "process executable must be an absolute normalized path")?;
        // `/` and `X:\` are the only normalized paths ending in a separator.
        if self.executable.ends_with(['/', '\\']) {
            return Err("process executable must name a file");
        }
        Ok(())
    }
}

pub fn validate_process_executables(entries: &[ProcessExecutable]) -> Result<(), &'static str> {
    if entries.len() > MAX_PROCESS_EXECUTABLES {
        return Err("at most 8 process executables may be granted");
    }
    for (index, entry) in entries.iter().enumerate() {
        entry.validate()?;
        if entries[..index].iter().any(|other| other.id == entry.id) {
            return Err("process executable IDs must be unique");
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessDirectory {
    pub grant_id: FileGrantId,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSize {
    pub columns: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub fn validate(self) -> Result<(), &'static str> {
        if self.columns == 0
            || self.rows == 0
            || self.columns > MAX_TERMINAL_DIMENSION
            || self.rows > MAX_TERMINAL_DIMENSION
        {
            return Err("terminal columns and rows must be between 1 and 1000");
        }
        Ok(())
    }
}

/// Explicit launch request. With `terminal`, the child's standard streams are
/// one pseudo-terminal; otherwise they are three pipes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<ProcessDirectory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalSize>,
}

fn plain(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.contains('\0')
}

pub fn validate_env_name(name: &str) -> Result<(), &'static str> {
    let mut bytes = name.bytes();
    if name.len() > MAX_PROCESS_ENV_NAME_BYTES
        || !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("environment names must be ASCII letters, digits and '_', not starting with a digit, at most 128 bytes");
    }
    Ok(())
}

impl ProcessLaunch {
    pub fn validate(&self) -> Result<(), &'static str> {
        crate::validate_root_id(&self.executable)
            .map_err(|_| "process executable must be a launch-policy ID")?;
        if self.args.len() > MAX_PROCESS_ARGS
            || self
                .args
                .iter()
                .any(|argument| !plain(argument, MAX_PROCESS_ARG_BYTES))
        {
            return Err(
                "process arguments must be at most 64 NUL-free strings of at most 4096 bytes",
            );
        }
        if self.env.len() > MAX_PROCESS_ENV {
            return Err("at most 64 environment variables may be set");
        }
        for (name, value) in &self.env {
            validate_env_name(name)?;
            if !plain(value, MAX_PROCESS_ENV_VALUE_BYTES) {
                return Err("environment values must be NUL-free and at most 4096 bytes");
            }
        }
        let total: usize = self.args.iter().map(String::len).sum::<usize>()
            + self
                .env
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>();
        if total > MAX_PROCESS_LAUNCH_BYTES {
            return Err("process arguments and environment exceed 32768 bytes");
        }
        if let Some(directory) = &self.cwd {
            validate_file_path(&directory.path)?;
        }
        if let Some(size) = self.terminal {
            size.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessSignal {
    Interrupt,
    Terminate,
    Kill,
    Hangup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStream {
    Stdout,
    Stderr,
    Terminal,
}

/// How the direct child ended. Exactly one of `code` and `signal` is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessExit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
}

impl ProcessExit {
    pub fn validate(self) -> Result<(), &'static str> {
        match (self.code, self.signal) {
            (Some(code), None) if (0..=255).contains(&code) => Ok(()),
            (None, Some(signal)) if (1..=64).contains(&signal) => Ok(()),
            _ => Err("a process exit has exactly one exit code (0-255) or signal number (1-64)"),
        }
    }
}

pub fn validate_process_output(data: &str) -> Result<(), &'static str> {
    if data.is_empty() {
        return Err("process output chunks are nonempty");
    }
    validate_chunk(data)
}

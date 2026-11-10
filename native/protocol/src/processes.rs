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
/// Bounds of the optional per-executable resource limits.
pub const MAX_PROCESS_CPU_SECONDS: u64 = 604_800;
pub const MIN_PROCESS_MEMORY_BYTES: u64 = 1 << 20;
pub const MAX_PROCESS_MEMORY_BYTES: u64 = 1 << 48;
pub const MIN_PROCESS_OPEN_FILES: u64 = 3;
pub const MAX_PROCESS_OPEN_FILES: u64 = 1 << 20;

/// Resource limits every child started from one executable entry runs under.
/// Each is optional; a platform that cannot enforce a requested limit refuses
/// the spawn instead of ignoring it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessLimits {
    /// CPU time in seconds (POSIX `RLIMIT_CPU`, Windows per-process job time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_seconds: Option<u64>,
    /// Memory in bytes (Linux `RLIMIT_AS`, Windows per-process job memory).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    /// Open descriptors (POSIX `RLIMIT_NOFILE`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_files: Option<u64>,
}

impl ProcessLimits {
    pub fn validate(self) -> Result<(), &'static str> {
        if self.cpu_seconds.is_none() && self.memory_bytes.is_none() && self.open_files.is_none() {
            return Err("process limits must set at least one limit");
        }
        if self
            .cpu_seconds
            .is_some_and(|value| !(1..=MAX_PROCESS_CPU_SECONDS).contains(&value))
        {
            return Err("process cpu_seconds must be between 1 and 604800");
        }
        if self.memory_bytes.is_some_and(|value| {
            !(MIN_PROCESS_MEMORY_BYTES..=MAX_PROCESS_MEMORY_BYTES).contains(&value)
        }) {
            return Err("process memory_bytes must be between 2^20 and 2^48");
        }
        if self.open_files.is_some_and(|value| {
            !(MIN_PROCESS_OPEN_FILES..=MAX_PROCESS_OPEN_FILES).contains(&value)
        }) {
            return Err("process open_files must be between 3 and 2^20");
        }
        Ok(())
    }

    /// The reserved launch-argument form: `cpu_seconds=N,memory_bytes=N,open_files=N`,
    /// listing only the limits that are set, in that order.
    pub fn to_argument(self) -> String {
        [
            ("cpu_seconds", self.cpu_seconds),
            ("memory_bytes", self.memory_bytes),
            ("open_files", self.open_files),
        ]
        .into_iter()
        .filter_map(|(name, value)| value.map(|value| format!("{name}={value}")))
        .collect::<Vec<_>>()
        .join(",")
    }

    /// Parses `to_argument`'s form strictly: known names, each at most once,
    /// canonical decimal values, in order, then validates the bounds.
    pub fn from_argument(text: &str) -> Result<Self, &'static str> {
        const MALFORMED: &str = "process limits must be cpu_seconds=N,memory_bytes=N,open_files=N";
        let mut limits = Self::default();
        let mut last = 0;
        for part in text.split(',') {
            let (name, value) = part.split_once('=').ok_or(MALFORMED)?;
            if value.is_empty()
                || value.len() > 20
                || !value.bytes().all(|byte| byte.is_ascii_digit())
                || (value.len() > 1 && value.starts_with('0'))
            {
                return Err(MALFORMED);
            }
            let value = value.parse::<u64>().map_err(|_| MALFORMED)?;
            let (order, slot) = match name {
                "cpu_seconds" => (1, &mut limits.cpu_seconds),
                "memory_bytes" => (2, &mut limits.memory_bytes),
                "open_files" => (3, &mut limits.open_files),
                _ => return Err(MALFORMED),
            };
            if order <= last {
                return Err(MALFORMED);
            }
            last = order;
            *slot = Some(value);
        }
        limits.validate()?;
        Ok(limits)
    }
}

/// One executable the trusted application named at native process launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessExecutable {
    pub id: String,
    pub executable: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<ProcessLimits>,
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
        if let Some(limits) = self.limits {
            limits.validate()?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        argument: String,
        limits: Option<ProcessLimits>,
    }

    #[derive(Deserialize)]
    struct Fixtures {
        arguments: Vec<Case>,
    }

    #[test]
    fn limit_arguments_share_the_checked_typescript_contract() {
        let fixtures: Fixtures = serde_json::from_str(include_str!(
            "../../../tests/fixtures/native-process-limits.json"
        ))
        .unwrap();
        for case in fixtures.arguments {
            let parsed = ProcessLimits::from_argument(&case.argument).ok();
            assert_eq!(parsed, case.limits, "{}", case.name);
            if let Some(limits) = parsed {
                assert_eq!(limits.to_argument(), case.argument, "{}", case.name);
            }
        }
    }

    #[test]
    fn executable_limits_are_validated_with_the_policy_entry() {
        let entry = |limits| ProcessExecutable {
            id: "shell".into(),
            executable: "/bin/sh".into(),
            limits,
        };
        assert!(entry(None).validate().is_ok());
        assert!(entry(Some(ProcessLimits {
            open_files: Some(16),
            ..ProcessLimits::default()
        }))
        .validate()
        .is_ok());
        assert!(entry(Some(ProcessLimits::default())).validate().is_err());
        assert!(entry(Some(ProcessLimits {
            cpu_seconds: Some(0),
            ..ProcessLimits::default()
        }))
        .validate()
        .is_err());
        let wire: ProcessExecutable = serde_json::from_str(
            r#"{"id":"shell","executable":"/bin/sh","limits":{"cpu_seconds":2}}"#,
        )
        .unwrap();
        assert_eq!(wire.limits.and_then(|limits| limits.cpu_seconds), Some(2));
        assert!(serde_json::from_str::<ProcessExecutable>(
            r#"{"id":"shell","executable":"/bin/sh","limits":{"threads":2}}"#
        )
        .is_err());
        assert_eq!(
            serde_json::to_string(&entry(None)).unwrap(),
            r#"{"id":"shell","executable":"/bin/sh"}"#
        );
    }
}

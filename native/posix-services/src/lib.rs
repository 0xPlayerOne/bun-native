//! Starting a POSIX child in an open directory descriptor, and under
//! resource limits.
//!
//! macOS has no `/proc/self/fd` and `Command::current_dir` takes only a path,
//! and a path recovered from a descriptor would reintroduce the
//! check-then-use race that grant descriptors exist to remove. `fchdir` in the
//! forked child names the directory by the descriptor itself. The only
//! unsafe operation is registering that step with `pre_exec`.
#![cfg(unix)]
#![deny(unsafe_code)]

use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt as _;
use std::process::Command;

/// The step the forked child runs before `exec`: `fchdir` on its own
/// duplicate of the descriptor. A raw system call, so it is safe to run
/// between `fork` and `exec`; it allocates nothing and takes no lock.
fn step(directory: &OwnedFd) -> io::Result<impl FnMut() -> io::Result<()> + Send + Sync + 'static> {
    // `try_clone` marks the copy close-on-exec, so the new program never
    // inherits it.
    let directory = directory.try_clone()?;
    Ok(move || rustix::process::fchdir(&directory).map_err(io::Error::from))
}

/// Make `command` start in `directory`.
pub fn start_in(command: &mut Command, directory: &OwnedFd) -> io::Result<()> {
    let step = step(directory)?;
    // SAFETY: `step` only calls `fchdir`, which is async-signal-safe, on a
    // descriptor it owns, and returns an OS error without allocating.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(step);
    }
    Ok(())
}

/// Make a pseudo-terminal `command` start in `directory`. The terminal's own
/// session setup still runs first.
pub fn start_in_terminal(
    command: pty_process::blocking::Command,
    directory: &OwnedFd,
) -> io::Result<pty_process::blocking::Command> {
    let step = step(directory)?;
    // SAFETY: as in `start_in`.
    #[allow(unsafe_code)]
    let command = unsafe { command.pre_exec(step) };
    Ok(command)
}

/// Resource limits a child takes before `exec`. Each set limit is both the
/// soft and the hard limit, except CPU time, whose hard limit is one second
/// later: the soft limit delivers `SIGXCPU`, and a child that ignores it is
/// killed at the hard limit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Limits {
    pub cpu_seconds: Option<u64>,
    /// `RLIMIT_AS`. Only Linux enforces it; callers refuse it elsewhere.
    #[cfg(target_os = "linux")]
    pub address_space_bytes: Option<u64>,
    pub open_files: Option<u64>,
}

fn limit_step(limits: Limits) -> impl FnMut() -> io::Result<()> + Send + Sync + 'static {
    use rustix::process::{Resource, Rlimit, setrlimit};
    move || {
        let exact = |value: u64| Rlimit {
            current: Some(value),
            maximum: Some(value),
        };
        if let Some(seconds) = limits.cpu_seconds {
            setrlimit(
                Resource::Cpu,
                Rlimit {
                    current: Some(seconds),
                    maximum: Some(seconds.saturating_add(1)),
                },
            )?;
        }
        #[cfg(target_os = "linux")]
        if let Some(bytes) = limits.address_space_bytes {
            setrlimit(Resource::As, exact(bytes))?;
        }
        if let Some(files) = limits.open_files {
            setrlimit(Resource::Nofile, exact(files))?;
        }
        Ok(())
    }
}

/// Make `command` start under `limits`.
pub fn limit(command: &mut Command, limits: Limits) {
    // SAFETY: the step only calls `setrlimit`, a raw system call that is
    // async-signal-safe, and returns an OS error without allocating.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(limit_step(limits));
    }
}

/// Make a pseudo-terminal `command` start under `limits`.
pub fn limit_terminal(
    command: pty_process::blocking::Command,
    limits: Limits,
) -> pty_process::blocking::Command {
    // SAFETY: as in `limit`.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(limit_step(limits))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsFd as _;

    fn directory(path: &std::path::Path) -> OwnedFd {
        rustix::fs::open(
            path,
            rustix::fs::OFlags::DIRECTORY | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .expect("open the directory")
    }

    #[test]
    fn a_child_starts_in_the_directory_descriptor() {
        let base = std::env::temp_dir().join(format!("bun-native-posix-{}", std::process::id()));
        std::fs::create_dir_all(base.join("inner")).unwrap();
        let fd = directory(&base.join("inner"));
        let mut command = Command::new("/bin/pwd");
        command.arg("-P");
        start_in(&mut command, &fd).unwrap();
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim_end(),
            base.join("inner").canonicalize().unwrap().to_str().unwrap()
        );
        // The descriptor is still open and usable by the parent.
        assert!(rustix::fs::fstat(fd.as_fd()).is_ok());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_descriptor_that_is_not_a_directory_fails_the_spawn() {
        let file = std::fs::File::open("/dev/null").unwrap();
        let fd = OwnedFd::from(file);
        let mut command = Command::new("/bin/true");
        start_in(&mut command, &fd).unwrap();
        let error = command.output().expect_err("fchdir must fail");
        assert_eq!(
            error.raw_os_error(),
            Some(rustix::io::Errno::NOTDIR.raw_os_error())
        );
    }

    fn limited(script: &str, limits: Limits) -> std::process::Output {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        limit(&mut command, limits);
        command.output().unwrap()
    }

    #[test]
    fn a_child_starts_under_its_limits() {
        let output = limited(
            "ulimit -t; ulimit -n",
            Limits {
                cpu_seconds: Some(7),
                #[cfg(target_os = "linux")]
                address_space_bytes: None,
                open_files: Some(32),
            },
        );
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "7\n32\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_linux_child_starts_under_its_address_space_limit() {
        let output = limited(
            "ulimit -v",
            Limits {
                address_space_bytes: Some(256 << 20),
                ..Limits::default()
            },
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), "262144\n");
    }

    #[test]
    fn a_cpu_bound_child_is_stopped_by_its_cpu_limit() {
        use std::os::unix::process::ExitStatusExt as _;
        let output = limited(
            "while :; do :; done",
            Limits {
                cpu_seconds: Some(1),
                ..Limits::default()
            },
        );
        assert_eq!(
            output.status.signal(),
            Some(rustix::process::Signal::XCPU.as_raw())
        );
    }
}

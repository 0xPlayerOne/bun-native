//! Starting a POSIX child in an open directory descriptor.
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
}

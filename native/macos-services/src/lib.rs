//! macOS owned-process boundary: start a child in an already-opened directory.
//!
//! macOS has no `/proc/self/fd` and `Command::current_dir` takes a path, which
//! would reintroduce the check-then-use race that filesystem grant descriptors
//! exist to remove. `fchdir` on the grant descriptor in the child, between
//! fork and exec, keeps the descriptor as the only name for the directory.
//! `fchdir` is async-signal-safe and allocates nothing, so it may run there.
//!
//! The only unsafe code is the two `pre_exec` registrations below.
#![cfg(target_os = "macos")]

use std::io;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::process::Command;

/// The hook both wrappers register. It copies the descriptor number only; the
/// caller keeps the descriptor open until the child has been spawned.
#[allow(unsafe_code)]
fn change_directory(fd: i32) -> impl FnMut() -> io::Result<()> + Send + Sync + 'static {
    move || {
        // SAFETY: `fchdir` only reads its integer argument and is
        // async-signal-safe, which is all a post-fork closure may call.
        if unsafe { libc::fchdir(fd) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

/// Makes `command` start in `directory`. The descriptor must stay open until
/// the command has been spawned.
#[allow(unsafe_code)]
pub fn start_in_directory(command: &mut Command, directory: BorrowedFd<'_>) {
    use std::os::unix::process::CommandExt as _;
    // SAFETY: the registered closure calls only `fchdir`, see above.
    unsafe { command.pre_exec(change_directory(directory.as_raw_fd())) };
}

/// The same for a pseudo-terminal command.
#[allow(unsafe_code)]
pub fn start_pty_in_directory(
    command: pty_process::blocking::Command,
    directory: BorrowedFd<'_>,
) -> pty_process::blocking::Command {
    // SAFETY: the registered closure calls only `fchdir`, see above.
    unsafe { command.pre_exec(change_directory(directory.as_raw_fd())) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsFd as _;
    use std::process::Stdio;

    fn base(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bun-native-macos-services-{name}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn a_child_starts_in_the_descriptor_not_a_path() {
        let directory = base("start");
        let file = std::fs::File::open(&directory).unwrap();
        // The path is removed and replaced by a different directory after the
        // descriptor was opened; the child must still land in the original one.
        let moved = directory.with_extension("moved");
        std::fs::rename(&directory, &moved).unwrap();
        std::fs::create_dir(&directory).unwrap();
        let mut command = Command::new("/bin/pwd");
        command.arg("-P").stdout(Stdio::piped());
        start_in_directory(&mut command, file.as_fd());
        let output = command.output().unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim_end(),
            moved.to_str().unwrap()
        );
        std::fs::remove_dir_all(&directory).unwrap();
        std::fs::remove_dir_all(&moved).unwrap();
    }

    #[test]
    fn a_descriptor_that_is_not_a_directory_fails_the_spawn() {
        let file = std::fs::File::open("/dev/null").unwrap();
        let mut command = Command::new("/usr/bin/true");
        start_in_directory(&mut command, file.as_fd());
        let error = command.status().unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ENOTDIR));
    }
}

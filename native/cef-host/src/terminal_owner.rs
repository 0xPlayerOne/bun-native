//! Private Unix PTY owner. No PID-bearing command or renderer-facing endpoint.
//! fd 3 is a dedicated Bun socketpair; EOF is loss of the backend lease.
#[cfg(unix)]
mod unix {
    use std::{
        io::{self, Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                net::UnixStream,
                process::{CommandExt, ExitStatusExt},
            },
        },
        path::Path,
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    // Wire v1: ready [1], exit [2, kind (code=0/signal=1), value], failure [3, denied=1/other=2].
    // Input is a single POSIX signal byte. No identities arrive over this channel.
    const GRACE: Duration = Duration::from_secs(2);
    const SIGNALS: [i32; 8] = [
        libc::SIGHUP,
        libc::SIGINT,
        libc::SIGQUIT,
        libc::SIGTERM,
        libc::SIGUSR1,
        libc::SIGUSR2,
        libc::SIGWINCH,
        libc::SIGKILL,
    ];

    fn wait_owned(pid: u32, blocking: bool) -> io::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            let flags = libc::WEXITED | libc::WNOWAIT | if blocking { 0 } else { libc::WNOHANG };
            if unsafe { libc::waitid(libc::P_PID, pid, &mut info, flags) } == 0 {
                #[cfg(target_os = "macos")]
                let observed = info.si_pid;
                #[cfg(target_os = "linux")]
                let observed = unsafe { info.si_pid() };
                return Ok(observed == pid as i32);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn only_retained_zombie(pid: i32) -> bool {
        unsafe extern "C" {
            fn proc_listpgrppids(group: u32, buffer: *mut libc::c_void, size: i32) -> i32;
        }
        // Two slots suffice to reject any other member or a truncated result.
        let mut members = [0_i32; 2];
        let count = unsafe { proc_listpgrppids(pid as u32, members.as_mut_ptr().cast(), 8) };
        count == 1 && members[0] == pid
    }

    /// This child is never passed to try_wait/wait until all group signals finish.
    /// WNOWAIT retains the group leader's PID even after its natural exit.
    struct Group(Child);
    impl Group {
        fn signal(&self, signal: i32) -> io::Result<()> {
            let exited = wait_owned(self.0.id(), false)?;
            #[cfg(not(target_os = "macos"))]
            let _ = exited;
            let pid = i32::try_from(self.0.id()).map_err(|_| io::ErrorKind::InvalidInput)?;
            if unsafe { libc::kill(-pid, signal) } == 0 {
                Ok(())
            } else {
                let error = io::Error::last_os_error();
                // Darwin's killpg excludes zombies, then returns EPERM when
                // no live member remains. Do not reinterpret general EPERM:
                // prove only the retained zombie remains via a bounded kernel
                // group query. No PID from that query is ever signalled.
                #[cfg(target_os = "macos")]
                if error.raw_os_error() == Some(libc::EPERM) && exited && only_retained_zombie(pid)
                {
                    return Ok(());
                }
                if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
        fn finish(&mut self) -> io::Result<std::process::ExitStatus> {
            self.signal(libc::SIGKILL)?;
            self.0.wait()
        }
    }

    fn command() -> io::Result<Command> {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        if args.is_empty()
            || args.len() > 257
            || !Path::new(&args[0]).is_absolute()
            || args.iter().any(|a| a.is_empty() || a.len() > 16384)
            || args.iter().map(|a| a.len()).sum::<usize>() > 81920
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut command = Command::new(&args[0]);
        command
            .args(&args[1..])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        command.process_group(0);
        // Executed before user code. Set the command's group as PTY foreground;
        // the owner stays outside it and cannot be killed by its own group signal.
        unsafe {
            command.pre_exec(|| {
                if libc::tcsetpgrp(0, libc::getpid()) != 0 {
                    return Err(io::Error::last_os_error());
                }
                for signal in SIGNALS.into_iter().filter(|s| *s != libc::SIGKILL) {
                    libc::signal(signal, libc::SIG_DFL);
                }
                libc::signal(libc::SIGPIPE, libc::SIG_DFL);
                libc::signal(libc::SIGTTOU, libc::SIG_DFL);
                Ok(())
            });
        }
        Ok(command)
    }

    fn supervise(control: &mut UnixStream) -> io::Result<()> {
        let mut command = command()?;
        let (mut wake, mut notify) = UnixStream::pair()?;
        // The only spawning path is gated on a live, private backend lease.
        // If Bun dies before admission, no application process is created.
        let mut admit = [0];
        control.read_exact(&mut admit)?;
        if admit != [0] {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut group = Group(command.spawn()?);
        let pid = group.0.id();
        let watcher = thread::Builder::new()
            .name("terminal-exit".into())
            .spawn(move || {
                let result = wait_owned(pid, true);
                let _ = notify.write_all(&[u8::from(matches!(result, Ok(true)))]);
            });
        let result = (|| {
            let watcher = watcher?;
            control.write_all(&[1])?;
            let mut deadline: Option<Instant> = None;
            loop {
                let mut fds = [
                    libc::pollfd {
                        fd: control.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                    libc::pollfd {
                        fd: wake.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                ];
                let timeout = match deadline {
                    None => -1,
                    Some(end) => {
                        let remaining = end.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        remaining.as_millis().clamp(1, i32::MAX as u128) as i32
                    }
                };
                if unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout) } < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                if fds[1].revents != 0 {
                    let mut observed = [0];
                    wake.read_exact(&mut observed)?;
                    if observed != [1] {
                        return Err(io::ErrorKind::Other.into());
                    }
                    break;
                }
                if fds[0].revents != 0 {
                    let mut signal = [0];
                    match control.read(&mut signal) {
                        Ok(0) => break,
                        Ok(_) if i32::from(signal[0]) == libc::SIGKILL => break,
                        Ok(_) if SIGNALS.contains(&i32::from(signal[0])) => {
                            group.signal(i32::from(signal[0]))?;
                            if i32::from(signal[0]) == libc::SIGTERM {
                                deadline.get_or_insert_with(|| Instant::now() + GRACE);
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                        _ => return Err(io::ErrorKind::InvalidData.into()),
                    }
                }
            }
            let status = group.finish()?;
            watcher.join().map_err(|_| io::ErrorKind::Other)?;
            let (kind, value) = match status.code() {
                Some(code) => (0, code),
                None => (1, status.signal().ok_or(io::ErrorKind::Other)?),
            };
            // This confirms group signalling and direct-command wait, never a
            // fabricated observation that every possible descendant has exited.
            control.write_all(&[2, kind, value as u8])
        })();
        // Any protocol, notification, or write failure must still attempt exact
        // owned cleanup. After a successful wait ECHILD forbids another signal.
        if result.is_err() {
            let _ = group.finish();
        }
        result
    }

    pub fn run() -> io::Result<()> {
        // fd 3 is supplied by Bun, never discovered by path, process name or PID.
        if unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut control = unsafe { UnixStream::from_raw_fd(3) };
        control.set_nonblocking(false)?;
        // The backend's death can hang up the controlling terminal. Only the
        // command group receives user signals; EOF, not SIGHUP, owns this helper.
        unsafe {
            for signal in SIGNALS.into_iter().filter(|s| *s != libc::SIGKILL) {
                libc::signal(signal, libc::SIG_IGN);
            }
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
            libc::signal(libc::SIGTTOU, libc::SIG_IGN);
        }
        let result = supervise(&mut control);
        if let Err(error) = &result {
            let denied = error.raw_os_error() == Some(libc::EPERM)
                || error.raw_os_error() == Some(libc::EACCES);
            let _ = control.write_all(&[3, if denied { 1 } else { 2 }]);
        }
        result
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn unreaped_group_identity_survives_exit_but_never_reaping() {
            let child = Command::new("/bin/sh")
                .args(["-c", "exit 7"])
                .process_group(0)
                .spawn()
                .unwrap();
            let mut group = Group(child);
            assert!(wait_owned(group.0.id(), true).unwrap());
            assert!(wait_owned(group.0.id(), false).unwrap());
            #[cfg(target_os = "macos")]
            assert!(only_retained_zombie(group.0.id() as i32));
            assert_eq!(group.finish().unwrap().code(), Some(7));
            // A stale owner fails before it can issue any kill syscall.
            assert_eq!(
                group.signal(libc::SIGKILL).unwrap_err().raw_os_error(),
                Some(libc::ECHILD)
            );
        }
    }
}

fn main() {
    #[cfg(unix)]
    let success = unix::run().is_ok();
    #[cfg(not(unix))]
    let success = false;
    if !success {
        std::process::exit(125);
    }
}

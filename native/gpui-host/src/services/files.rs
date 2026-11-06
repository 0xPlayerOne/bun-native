//! Scoped filesystem grants. A grant holds a directory descriptor opened from
//! an immutable launch root; every request resolves beneath that descriptor
//! without following any symbolic link, on a worker thread so neither the UI
//! thread nor the tree queue waits for filesystem I/O. Linux resolves with
//! `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`; macOS walks one validated
//! name at a time with `openat(O_NOFOLLOW | O_NOFOLLOW_ANY)` (see `walk`);
//! Windows walks one name at a time with handle-relative `NtCreateFile`
//! that never follows a reparse point (see `windows`).

#[cfg(target_os = "linux")]
mod openat2;
#[cfg(any(target_os = "macos", all(test, unix)))]
mod walk;
#[cfg(windows)]
mod windows;

use crate::channel::EventSink;
use async_channel::{Receiver, Sender};
#[cfg(unix)]
use base64::Engine as _;
#[cfg(unix)]
use base64::engine::general_purpose::STANDARD;
#[cfg(unix)]
use bun_native_protocol::{
    DirectoryEntry, FileKind, MAX_DIRECTORY_ENTRIES, MAX_FILE_OFFSET, WriteMode, validate_file_name,
};
use bun_native_protocol::{
    ErrorCode, Event, FileAccess, FileGrantId, FileOperation, FileResult, FilesystemRoot,
    MAX_FILE_GRANTS, MAX_SERVICE_REQUESTS, RequestId, WindowId,
};
use gpui::{App, BackgroundExecutor, Task};
#[cfg(unix)]
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, Stat, fstat, ftruncate, mkdirat, statat, unlinkat,
};
#[cfg(unix)]
use rustix::io::Errno;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::Write as _;
#[cfg(unix)]
use std::os::fd::OwnedFd;
#[cfg(unix)]
use std::os::unix::fs::FileExt as _;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
#[cfg(windows)]
pub(crate) use windows::open_root;
#[cfg(windows)]
pub(crate) use windows::working_directory;
#[cfg(windows)]
use windows::{Handle, UNAVAILABLE, probe, serve};

/// The handle a grant holds: a directory descriptor, or a Windows handle.
#[cfg(unix)]
type Handle = OwnedFd;

/// A live grant's directory handle, shared with an owned process for its cwd.
pub(crate) type Directory = Arc<Handle>;

type Failure = (ErrorCode, &'static str);

/// A directory larger than this cannot be paged in sorted order.
const MAX_SCANNED_ENTRIES: usize = 100_000;

/// Kernel-enforced resolution beneath a grant descriptor. Paths are already
/// validated: empty (the grant root) or `/`-joined names with no `.`, `..`,
/// empty or control-character components.
#[cfg(unix)]
trait Confine {
    /// Whether this kernel enforces the confinement; otherwise nothing is advertised.
    fn probe() -> bool;
    /// Opens a trusted launch root. The path may traverse links; the descriptor is the grant.
    fn open_root(path: &str) -> Result<OwnedFd, Errno>;
    /// Opens `path` beneath `root` with `flags` (plus `O_CLOEXEC | O_NOCTTY`),
    /// failing with `ELOOP` or `EXDEV` rather than following any link.
    fn beneath(root: &OwnedFd, path: &str, flags: OFlags, mode: Mode) -> Result<OwnedFd, Errno>;
    /// A directory descriptor at `path` beneath `root`, usable as a `*at` base.
    fn directory(root: &OwnedFd, path: &str) -> Result<OwnedFd, Errno>;
}

#[cfg(target_os = "linux")]
type Native = openat2::Openat2;
#[cfg(target_os = "macos")]
type Native = walk::Walk;

/// The reason grants are unavailable when the kernel lacks the confinement.
#[cfg(target_os = "linux")]
const UNAVAILABLE: &str = "filesystem grants require Linux openat2 confinement";
#[cfg(target_os = "macos")]
const UNAVAILABLE: &str = "filesystem grants require macOS openat O_NOFOLLOW confinement";

enum Work {
    OpenRoot(String),
    Request(Arc<Handle>, String, FileOperation),
}

enum Output {
    Opened(Handle),
    Result(FileResult),
}

struct Job {
    id: RequestId,
    work: Work,
    cancelled: Arc<AtomicBool>,
}

struct Completion {
    id: RequestId,
    result: Result<Output, Failure>,
}

struct Grant {
    window: WindowId,
    root: Arc<Handle>,
    access: FileAccess,
}

enum PendingKind {
    Open(FileAccess),
    Request,
}

struct Pending {
    window: WindowId,
    grant: FileGrantId,
    kind: PendingKind,
    cancelled: Arc<AtomicBool>,
}

struct Worker {
    jobs: Sender<Job>,
    thread: JoinHandle<()>,
}

enum WorkerState {
    NotStarted,
    Running(Worker),
    Stopped,
}

struct Inner {
    available: bool,
    roots: Vec<FilesystemRoot>,
    grants: RefCell<BTreeMap<FileGrantId, Grant>>,
    pending: RefCell<BTreeMap<RequestId, Pending>>,
    last_grant: Cell<u64>,
    worker: RefCell<WorkerState>,
    stopping: Arc<AtomicBool>,
    events: EventSink,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
pub(crate) struct Files(Rc<Inner>);

impl Files {
    pub(crate) fn new(events: EventSink, roots: Vec<FilesystemRoot>, _cx: &App) -> Self {
        let available = probe();
        Self(Rc::new(Inner {
            available,
            roots,
            grants: RefCell::new(BTreeMap::new()),
            pending: RefCell::new(BTreeMap::new()),
            last_grant: Cell::new(0),
            worker: RefCell::new(WorkerState::NotStarted),
            stopping: Arc::new(AtomicBool::new(false)),
            events,
        }))
    }

    pub(crate) fn available(&self) -> bool {
        self.0.available
    }

    fn live_grants(&self) -> usize {
        self.0.grants.borrow().len()
            + self
                .0
                .pending
                .borrow()
                .values()
                .filter(|pending| matches!(pending.kind, PendingKind::Open(_)))
                .count()
    }

    pub(crate) fn open(
        &self,
        request: (RequestId, WindowId, FileGrantId),
        root: &str,
        access: FileAccess,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, grant) = request;
        let root = self
            .0
            .roots
            .iter()
            .find(|candidate| candidate.id == root)
            .ok_or((
                ErrorCode::PermissionDenied,
                "this filesystem root was not granted at native process launch",
            ))?;
        if access > root.access {
            return Err((
                ErrorCode::PermissionDenied,
                "the requested access exceeds the filesystem root's launch grant",
            ));
        }
        if !self.available() {
            return Err((ErrorCode::ServiceUnavailable, UNAVAILABLE));
        }
        if grant.get() <= self.0.last_grant.get() {
            return Err((
                ErrorCode::InvalidHandle,
                "file grant IDs must increase across the session",
            ));
        }
        if self.live_grants() >= MAX_FILE_GRANTS {
            return Err((ErrorCode::LimitExceeded, "file grant limit exceeded"));
        }
        self.submit(
            Pending {
                window,
                grant,
                kind: PendingKind::Open(access),
                cancelled: Arc::new(AtomicBool::new(false)),
            },
            id,
            Work::OpenRoot(root.path.clone()),
            cx,
        )?;
        self.0.last_grant.set(grant.get());
        Ok(())
    }

    pub(crate) fn request(
        &self,
        request: (RequestId, WindowId, FileGrantId),
        path: String,
        operation: FileOperation,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, grant) = request;
        let root = {
            let grants = self.0.grants.borrow();
            let entry = grants
                .get(&grant)
                .filter(|entry| entry.window == window)
                .ok_or((
                    ErrorCode::InvalidHandle,
                    "file grant is closed or is not owned by this window",
                ))?;
            if operation.writes() && !entry.access.writable() {
                return Err((
                    ErrorCode::PermissionDenied,
                    "this file grant does not allow writes",
                ));
            }
            entry.root.clone()
        };
        self.submit(
            Pending {
                window,
                grant,
                kind: PendingKind::Request,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
            id,
            Work::Request(root, path, operation),
            cx,
        )
    }

    /// The descriptor of a live grant owned by `window`, for a process cwd.
    pub(crate) fn directory(&self, window: WindowId, grant: FileGrantId) -> Option<Directory> {
        self.0
            .grants
            .borrow()
            .get(&grant)
            .filter(|entry| entry.window == window)
            .map(|entry| entry.root.clone())
    }

    pub(crate) fn close(
        &self,
        id: RequestId,
        window: WindowId,
        grant: FileGrantId,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let owned = self
            .0
            .grants
            .borrow()
            .get(&grant)
            .is_some_and(|entry| entry.window == window);
        if !owned {
            return Err((
                ErrorCode::InvalidHandle,
                "file grant is closed or is not owned by this window",
            ));
        }
        self.revoke(
            |pending| pending.grant == grant,
            "file grant was closed",
            cx,
        );
        self.0.grants.borrow_mut().remove(&grant);
        self.0.events.send(
            Event::FileGrantClosed {
                id,
                window_id: window,
                grant_id: grant,
            },
            cx,
        );
        Ok(())
    }

    pub(crate) fn close_window(&self, window: WindowId, cx: &mut App) {
        self.revoke(
            |pending| pending.window == window,
            "file grant owner window was closed",
            cx,
        );
        self.0
            .grants
            .borrow_mut()
            .retain(|_, entry| entry.window != window);
    }

    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.store(true, Ordering::Release);
        self.revoke(|_| true, "file request cancelled during shutdown", cx);
        self.0.grants.borrow_mut().clear();
        match self.0.worker.replace(WorkerState::Stopped) {
            WorkerState::Running(worker) => Some(join(worker, cx.background_executor())),
            WorkerState::NotStarted | WorkerState::Stopped => None,
        }
    }

    fn revoke(&self, matches: impl Fn(&Pending) -> bool, message: &'static str, cx: &mut App) {
        self.0.pending.borrow_mut().retain(|id, pending| {
            if !matches(pending) {
                return true;
            }
            pending.cancelled.store(true, Ordering::Release);
            self.0.events.send(
                Event::Error {
                    id: Some(*id),
                    code: ErrorCode::Cancelled,
                    message: message.into(),
                },
                cx,
            );
            false
        });
    }

    fn submit(
        &self,
        pending: Pending,
        id: RequestId,
        work: Work,
        cx: &mut App,
    ) -> Result<(), Failure> {
        if self.0.pending.borrow().len() >= MAX_SERVICE_REQUESTS {
            return Err((
                ErrorCode::LimitExceeded,
                "native service request limit exceeded",
            ));
        }
        if self.0.stopping.load(Ordering::Acquire) {
            return Err((ErrorCode::Cancelled, "native file worker is shutting down"));
        }
        if matches!(*self.0.worker.borrow(), WorkerState::NotStarted) {
            self.start(cx)?;
        }
        let job = Job {
            id,
            work,
            cancelled: pending.cancelled.clone(),
        };
        match &*self.0.worker.borrow() {
            WorkerState::Running(worker) => worker.jobs.try_send(job).map_err(|_| {
                (
                    ErrorCode::LimitExceeded,
                    "native file worker queue is full or closed",
                )
            })?,
            _ => {
                return Err((
                    ErrorCode::NativeFailure,
                    "native file worker is unavailable",
                ));
            }
        }
        self.0.pending.borrow_mut().insert(id, pending);
        Ok(())
    }

    fn start(&self, cx: &mut App) -> Result<(), Failure> {
        let (jobs, requests) = async_channel::bounded(MAX_SERVICE_REQUESTS);
        let (results, responses) = async_channel::bounded(MAX_SERVICE_REQUESTS);
        let stopping = self.0.stopping.clone();
        let thread = std::thread::Builder::new()
            .name("bun-native-files".into())
            .spawn(move || worker(requests, results, stopping))
            .map_err(|_| (ErrorCode::NativeFailure, "cannot start native file worker"))?;
        self.0
            .worker
            .replace(WorkerState::Running(Worker { jobs, thread }));
        let files = self.clone();
        cx.spawn(async move |cx| {
            while let Ok(completion) = responses.recv().await {
                cx.update(|cx| files.complete(completion, cx));
            }
            cx.update(|cx| {
                files.revoke(|_| true, "native file worker stopped", cx);
            });
        })
        .detach();
        Ok(())
    }

    fn complete(&self, completion: Completion, cx: &mut App) {
        let Some(pending) = self.0.pending.borrow_mut().remove(&completion.id) else {
            // Revoked: the error reply was already sent and any descriptor drops here.
            return;
        };
        let id = completion.id;
        let event = match (completion.result, pending.kind) {
            (Ok(Output::Opened(root)), PendingKind::Open(access)) => {
                self.0.grants.borrow_mut().insert(
                    pending.grant,
                    Grant {
                        window: pending.window,
                        root: Arc::new(root),
                        access,
                    },
                );
                Event::FileGrantOpened {
                    id,
                    window_id: pending.window,
                    grant_id: pending.grant,
                }
            }
            (Ok(Output::Result(result)), PendingKind::Request) => match result.validate() {
                Ok(()) => Event::FileResult {
                    id,
                    window_id: pending.window,
                    grant_id: pending.grant,
                    result,
                },
                Err(message) => Event::Error {
                    id: Some(id),
                    code: ErrorCode::NativeFailure,
                    message: message.into(),
                },
            },
            (Err((code, message)), _) => Event::Error {
                id: Some(id),
                code,
                message: message.into(),
            },
            _ => Event::Error {
                id: Some(id),
                code: ErrorCode::NativeFailure,
                message: "native file worker returned a mismatched result".into(),
            },
        };
        self.0.events.send(event, cx);
    }
}

fn join(worker: Worker, executor: &BackgroundExecutor) -> Task<()> {
    executor.spawn(async move {
        // Closing the queue ends the worker after at most its current operation.
        drop(worker.jobs);
        let _ = worker.thread.join();
    })
}

fn worker(jobs: Receiver<Job>, results: Sender<Completion>, stopping: Arc<AtomicBool>) {
    while let Ok(job) = jobs.recv_blocking() {
        if stopping.load(Ordering::Acquire) {
            break;
        }
        if job.cancelled.load(Ordering::Acquire) {
            continue;
        }
        let result = match job.work {
            Work::OpenRoot(path) => open_root(&path).map(Output::Opened),
            Work::Request(root, path, operation) => {
                serve(&root, &path, &operation).map(Output::Result)
            }
        };
        if results
            .send_blocking(Completion { id: job.id, result })
            .is_err()
        {
            break;
        }
    }
}

#[cfg(unix)]
fn probe() -> bool {
    Native::probe()
}

#[cfg(unix)]
fn open_root(path: &str) -> Result<OwnedFd, Failure> {
    Native::open_root(path).map_err(failure)
}

#[cfg(unix)]
fn serve(root: &OwnedFd, path: &str, operation: &FileOperation) -> Result<FileResult, Failure> {
    perform::<Native>(root, path, operation)
}

#[cfg(unix)]
pub(crate) fn failure(error: Errno) -> Failure {
    match error {
        Errno::NOENT => (ErrorCode::NotFound, "no file exists at this grant path"),
        Errno::EXIST => (
            ErrorCode::AlreadyExists,
            "a file already exists at this grant path",
        ),
        Errno::LOOP | Errno::XDEV => (
            ErrorCode::PathDenied,
            "the grant path crosses a symbolic link or leaves the grant root",
        ),
        // A FIFO without a reader refuses a nonblocking writer with ENXIO.
        Errno::NOTDIR | Errno::ISDIR | Errno::NXIO => (
            ErrorCode::WrongKind,
            "the grant path names the wrong kind of file for this operation",
        ),
        Errno::NOTEMPTY => (ErrorCode::NotEmpty, "the directory is not empty"),
        Errno::ACCESS | Errno::PERM | Errno::ROFS => (
            ErrorCode::AccessDenied,
            "the operating system denied this file operation",
        ),
        Errno::NAMETOOLONG => (ErrorCode::LimitExceeded, "the native path is too long"),
        Errno::NOSYS => (ErrorCode::ServiceUnavailable, UNAVAILABLE),
        Errno::NOSPC | Errno::DQUOT => (ErrorCode::NativeFailure, "the filesystem is full"),
        _ => (ErrorCode::NativeFailure, "the native file operation failed"),
    }
}

/// A directory descriptor at `path` beneath a grant root, never following links.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn directory_beneath(root: &OwnedFd, path: &str) -> Result<OwnedFd, Failure> {
    Native::directory(root, path).map_err(failure)
}

#[cfg(unix)]
fn parent<'a, C: Confine>(root: &OwnedFd, path: &'a str) -> Result<(OwnedFd, &'a str), Failure> {
    let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
    Ok((C::directory(root, directory).map_err(failure)?, name))
}

#[cfg(unix)]
fn kind(file_type: FileType) -> FileKind {
    match file_type {
        FileType::RegularFile => FileKind::File,
        FileType::Directory => FileKind::Directory,
        FileType::Symlink => FileKind::Symlink,
        _ => FileKind::Other,
    }
}

#[cfg(unix)]
fn regular(fd: &OwnedFd) -> Result<Stat, Failure> {
    let stat = fstat(fd).map_err(failure)?;
    if FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile {
        Ok(stat)
    } else {
        Err((
            ErrorCode::WrongKind,
            "the grant path does not name a regular file",
        ))
    }
}

#[cfg(unix)]
fn modified_ms(stat: &Stat) -> i64 {
    let seconds = i128::from(stat.st_mtime);
    let nanoseconds = i128::from(stat.st_mtime_nsec);
    let limit = i128::from(MAX_FILE_OFFSET);
    (seconds * 1_000 + nanoseconds.div_euclid(1_000_000)).clamp(-limit, limit) as i64
}

#[cfg(unix)]
fn perform<C: Confine>(
    root: &OwnedFd,
    path: &str,
    operation: &FileOperation,
) -> Result<FileResult, Failure> {
    let beneath = |flags, mode| C::beneath(root, path, flags, mode).map_err(failure);
    match operation {
        FileOperation::Stat {} => {
            // The entry itself is examined: a link reports `symlink` and is not followed.
            let stat = if path.is_empty() {
                fstat(root)
            } else {
                let (parent, name) = parent::<C>(root, path)?;
                statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW)
            }
            .map_err(failure)?;
            Ok(FileResult::Stat {
                file_kind: kind(FileType::from_raw_mode(stat.st_mode)),
                size: u64::try_from(stat.st_size)
                    .unwrap_or(0)
                    .min(MAX_FILE_OFFSET),
                modified_ms: modified_ms(&stat),
            })
        }
        FileOperation::List { after } => list(
            beneath(OFlags::RDONLY | OFlags::DIRECTORY, Mode::empty())?,
            after.as_deref(),
        ),
        FileOperation::Read { offset, length } => {
            let fd = beneath(OFlags::RDONLY | OFlags::NONBLOCK, Mode::empty())?;
            let stat = regular(&fd)?;
            let file = File::from(fd);
            let mut buffer = vec![0; *length];
            let mut filled = 0;
            while filled < buffer.len() {
                match file.read_at(&mut buffer[filled..], offset + filled as u64) {
                    Ok(0) => break,
                    Ok(read) => filled += read,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(error) => {
                        return Err(failure(Errno::from_io_error(&error).unwrap_or(Errno::IO)));
                    }
                }
            }
            buffer.truncate(filled);
            let size = u64::try_from(stat.st_size).unwrap_or(0);
            Ok(FileResult::Read {
                data: STANDARD.encode(&buffer),
                end_of_file: filled < *length || offset + filled as u64 >= size,
            })
        }
        FileOperation::Write { mode, data } => {
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| (ErrorCode::InvalidCommand, "file data is not valid base64"))?;
            let flags = OFlags::WRONLY
                | OFlags::NONBLOCK
                | match mode {
                    WriteMode::Create => OFlags::CREATE | OFlags::EXCL,
                    WriteMode::Truncate => OFlags::CREATE,
                    WriteMode::Append => OFlags::APPEND,
                };
            // A creation mode is passed only when the open can create.
            let creation = if flags.contains(OFlags::CREATE) {
                Mode::from_raw_mode(0o666)
            } else {
                Mode::empty()
            };
            let fd = beneath(flags, creation)?;
            // Special files are refused before any byte is written or truncated.
            regular(&fd)?;
            if *mode == WriteMode::Truncate {
                ftruncate(&fd, 0).map_err(failure)?;
            }
            let mut file = File::from(fd);
            file.write_all(&bytes)
                .map_err(|error| failure(Errno::from_io_error(&error).unwrap_or(Errno::IO)))?;
            Ok(FileResult::Written { bytes: bytes.len() })
        }
        FileOperation::CreateDirectory {} => {
            let (parent, name) = parent::<C>(root, path)?;
            mkdirat(&parent, name, Mode::from_raw_mode(0o777)).map_err(failure)?;
            Ok(FileResult::Done {})
        }
        FileOperation::Remove {} => {
            let (parent, name) = parent::<C>(root, path)?;
            let stat = statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(failure)?;
            let flags = if FileType::from_raw_mode(stat.st_mode) == FileType::Directory {
                AtFlags::REMOVEDIR
            } else {
                AtFlags::empty()
            };
            // A symbolic link entry is removed itself; its target is untouched.
            unlinkat(&parent, name, flags).map_err(failure)?;
            Ok(FileResult::Done {})
        }
    }
}

#[cfg(unix)]
fn list(fd: OwnedFd, after: Option<&str>) -> Result<FileResult, Failure> {
    let mut directory = rustix::fs::Dir::read_from(&fd).map_err(failure)?;
    let mut names = Vec::new();
    let mut omitted = 0;
    let mut scanned = 0;
    while let Some(entry) = directory.read() {
        let entry = entry.map_err(failure)?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        scanned += 1;
        if scanned > MAX_SCANNED_ENTRIES {
            return Err((ErrorCode::LimitExceeded, "directory exceeds 100000 entries"));
        }
        match std::str::from_utf8(bytes) {
            Ok(name) if validate_file_name(name).is_ok() => {
                names.push((name.to_owned(), entry.file_type()));
            }
            _ => omitted += 1,
        }
    }
    names.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    let start = after.map_or(0, |after| {
        names.partition_point(|(name, _)| name.as_bytes() <= after.as_bytes())
    });
    let remaining = &names[start..];
    let page = &remaining[..remaining.len().min(MAX_DIRECTORY_ENTRIES)];
    let mut entries = Vec::with_capacity(page.len());
    for (name, file_type) in page {
        let file_type = if *file_type == FileType::Unknown {
            statat(&fd, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                .map(|stat| FileType::from_raw_mode(stat.st_mode))
                .unwrap_or(FileType::Unknown)
        } else {
            *file_type
        };
        entries.push(DirectoryEntry {
            name: name.clone(),
            kind: kind(file_type),
        });
    }
    Ok(FileResult::List {
        complete: page.len() == remaining.len(),
        entries,
        omitted,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temp() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "bun-native-files-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    fn code(result: Result<FileResult, Failure>) -> ErrorCode {
        result.unwrap_err().0
    }

    /// Every backend this target compiles runs the same real-file suite. On
    /// Linux that includes the macOS walk (without `O_NOFOLLOW_ANY`, which
    /// Linux lacks), so its per-component logic is exercised on every run.
    macro_rules! backends {
        ($($suite:ident),*) => {
            $(
                mod $suite {
                    #[cfg(target_os = "linux")]
                    #[test]
                    fn openat2() {
                        assert!(<super::super::openat2::Openat2 as super::super::Confine>::probe());
                        super::$suite::<super::super::openat2::Openat2>();
                    }
                    #[test]
                    fn walk() {
                        assert_eq!(super::super::walk::Walk::check(), Ok(()));
                        super::$suite::<super::super::walk::Walk>();
                    }
                }
            )*
        };
    }
    backends!(confinement, directory_links, special_files);

    #[test]
    fn the_native_backend_is_available() {
        assert!(Native::probe());
    }

    /// Requests stay beneath the grant without following links.
    fn confinement<C: Confine>() {
        let base = temp();
        let root_path = base.join("root");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::write(base.join("secret"), b"outside").unwrap();
        symlink(base.join("secret"), root_path.join("link")).unwrap();
        symlink(&base, root_path.join("up")).unwrap();
        let root = C::open_root(root_path.to_str().unwrap()).unwrap();

        let write = |path: &str, mode, data: &[u8]| {
            perform::<C>(
                &root,
                path,
                &FileOperation::Write {
                    mode,
                    data: STANDARD.encode(data),
                },
            )
        };
        assert_eq!(
            write("a.txt", WriteMode::Create, b"hello").unwrap(),
            FileResult::Written { bytes: 5 }
        );
        assert_eq!(
            code(write("a.txt", WriteMode::Create, b"x")),
            ErrorCode::AlreadyExists
        );
        write("a.txt", WriteMode::Append, b" world").unwrap();
        assert_eq!(
            perform::<C>(
                &root,
                "a.txt",
                &FileOperation::Read {
                    offset: 6,
                    length: 64
                }
            )
            .unwrap(),
            FileResult::Read {
                data: STANDARD.encode(b"world"),
                end_of_file: true
            }
        );
        write("a.txt", WriteMode::Truncate, b"new").unwrap();
        assert_eq!(std::fs::read(root_path.join("a.txt")).unwrap(), b"new");

        // Links are never followed, inside or out of the grant.
        for path in ["link", "up/secret"] {
            assert_eq!(
                code(perform::<C>(
                    &root,
                    path,
                    &FileOperation::Read {
                        offset: 0,
                        length: 8
                    }
                )),
                ErrorCode::PathDenied,
                "{path}"
            );
        }
        assert_eq!(
            code(write("link", WriteMode::Truncate, b"x")),
            ErrorCode::PathDenied
        );
        assert_eq!(std::fs::read(base.join("secret")).unwrap(), b"outside");
        assert!(matches!(
            perform::<C>(&root, "link", &FileOperation::Stat {}).unwrap(),
            FileResult::Stat {
                file_kind: FileKind::Symlink,
                ..
            }
        ));

        perform::<C>(&root, "dir", &FileOperation::CreateDirectory {}).unwrap();
        write("dir/b", WriteMode::Create, b"").unwrap();
        assert_eq!(
            code(perform::<C>(&root, "dir", &FileOperation::Remove {})),
            ErrorCode::NotEmpty
        );
        assert_eq!(
            code(perform::<C>(&root, "a.txt/x", &FileOperation::Stat {})),
            ErrorCode::WrongKind
        );
        assert_eq!(
            code(write("dir", WriteMode::Truncate, b"x")),
            ErrorCode::WrongKind
        );
        assert_eq!(
            code(perform::<C>(&root, "missing", &FileOperation::Stat {})),
            ErrorCode::NotFound
        );

        let FileResult::List {
            entries, complete, ..
        } = perform::<C>(&root, "", &FileOperation::List { after: None }).unwrap()
        else {
            panic!("list result")
        };
        assert!(complete);
        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.kind))
                .collect::<Vec<_>>(),
            [
                ("a.txt", FileKind::File),
                ("dir", FileKind::Directory),
                ("link", FileKind::Symlink),
                ("up", FileKind::Symlink),
            ]
        );
        let FileResult::List { entries, .. } = perform::<C>(
            &root,
            "",
            &FileOperation::List {
                after: Some("dir".into()),
            },
        )
        .unwrap() else {
            panic!("list result")
        };
        assert_eq!(entries[0].name, "link");

        // Removing a link removes the entry, not its target.
        perform::<C>(&root, "link", &FileOperation::Remove {}).unwrap();
        assert!(base.join("secret").exists());
        perform::<C>(&root, "dir/b", &FileOperation::Remove {}).unwrap();
        perform::<C>(&root, "dir", &FileOperation::Remove {}).unwrap();

        // A renamed root keeps its grant; the descriptor names the directory.
        let moved = base.join("moved");
        std::fs::rename(&root_path, &moved).unwrap();
        assert!(matches!(
            perform::<C>(&root, "a.txt", &FileOperation::Stat {}).unwrap(),
            FileResult::Stat { size: 3, .. }
        ));
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Links to directories are refused as the final name and mid-path, for
    /// every operation, and nothing is created outside the grant.
    fn directory_links<C: Confine>() {
        let base = temp();
        let root_path = base.join("root");
        std::fs::create_dir_all(root_path.join("inner")).unwrap();
        symlink(&base, root_path.join("up")).unwrap();
        symlink(root_path.join("inner"), root_path.join("inner-link")).unwrap();
        let root = C::open_root(root_path.to_str().unwrap()).unwrap();
        let operations = [
            FileOperation::List { after: None },
            FileOperation::CreateDirectory {},
            FileOperation::Remove {},
            FileOperation::Write {
                mode: WriteMode::Create,
                data: STANDARD.encode(b"x"),
            },
        ];
        for link in ["up", "inner-link"] {
            assert_eq!(
                code(perform::<C>(&root, link, &operations[0])),
                ErrorCode::PathDenied,
                "list {link}"
            );
            for operation in &operations {
                let path = format!("{link}/new");
                assert_eq!(
                    code(perform::<C>(&root, &path, operation)),
                    ErrorCode::PathDenied,
                    "{path} {operation:?}"
                );
            }
        }
        assert!(!base.join("new").exists());
        assert!(!root_path.join("inner/new").exists());
        assert!(matches!(
            perform::<C>(&root, "", &FileOperation::Stat {}).unwrap(),
            FileResult::Stat {
                file_kind: FileKind::Directory,
                ..
            }
        ));
        assert_eq!(
            code(perform::<C>(
                &root,
                "inner",
                &FileOperation::Read {
                    offset: 0,
                    length: 1
                }
            )),
            ErrorCode::WrongKind
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Special files are refused before I/O.
    fn special_files<C: Confine>() {
        let base = temp();
        let fifo = base.join("fifo");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        let root = C::open_root(base.to_str().unwrap()).unwrap();
        assert_eq!(
            code(perform::<C>(
                &root,
                "fifo",
                &FileOperation::Read {
                    offset: 0,
                    length: 1
                }
            )),
            ErrorCode::WrongKind
        );
        assert_eq!(
            code(perform::<C>(
                &root,
                "fifo",
                &FileOperation::Write {
                    mode: WriteMode::Append,
                    data: STANDARD.encode(b"x")
                }
            )),
            ErrorCode::WrongKind
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}

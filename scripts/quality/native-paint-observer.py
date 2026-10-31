"""Bounded Linux file-event observation of a complete expected native paint.

This measures command-start to validated JSONL observation, never presentation.
The producer log must be append-only. No app process or input command is created
here: the existing native driver retains ownership of both.
"""

import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import stat
import struct
import threading
import time


MAX_LOG_BYTES = 4 * 1024 * 1024
MAX_RECORD_BYTES = 65_536
MAX_NOTIFICATIONS = 32_768
IN_MODIFY = 0x00000002
IN_ATTRIB = 0x00000004
IN_CLOSE_WRITE = 0x00000008
IN_DELETE_SELF = 0x00000400
IN_MOVE_SELF = 0x00000800
IN_UNMOUNT = 0x00002000
IN_Q_OVERFLOW = 0x00004000
IN_IGNORED = 0x00008000
IN_DONT_FOLLOW = 0x02000000
EVENT = struct.Struct("iIII")


def notification_count(data, watch):
    """Validate the entire read before trusting file contents after that wakeup."""
    position = count = 0
    while position < len(data):
        if len(data) - position < EVENT.size:
            raise RuntimeError("Truncated inotify notification")
        identity, mask, _cookie, name_bytes = EVENT.unpack_from(data, position)
        position += EVENT.size + name_bytes
        if position > len(data):
            raise RuntimeError("Truncated inotify notification name")
        if mask & IN_Q_OVERFLOW:
            raise RuntimeError("Native paint inotify queue overflowed")
        if mask & (IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT | IN_IGNORED):
            raise RuntimeError("Native evidence file was moved, removed or unwatched")
        if (
            identity != watch
            or name_bytes
            or not mask
            or mask & ~(IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE)
        ):
            raise RuntimeError("Unexpected native evidence watch identity")
        count += 1
    return count


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate native evidence object field")
        value[key] = item
    return value


def invalid_constant(_value):
    raise ValueError("Non-finite native evidence number")


def same_json(left, right):
    # JSON numbers may be emitted as 24 or 24.0, but booleans must never alias
    # window/node IDs or revision numbers through Python's True == 1 behavior.
    if type(left) is bool or type(right) is bool:
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            same_json(left[key], value) for key, value in right.items()
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            same_json(a, b) for a, b in zip(left, right, strict=True)
        )
    return left == right


class PaintObserver:
    """Prepare before input, begin immediately before the command, then join.

    A thread reads only the owned log/notification descriptors. Context exit
    wakes and joins it even if input injection fails or the driver is cancelled.
    """

    def __init__(self, path, nonce, expected, *, timeout):
        if not isinstance(nonce, str) or not nonce or len(nonce) > 128:
            raise ValueError("Native paint observation requires a bounded nonce")
        if type(timeout) not in (int, float) or not math.isfinite(timeout):
            raise ValueError("Native paint observation needs a finite deadline")
        if not 0 < timeout <= 60:
            raise ValueError("Native paint observation deadline must be in (0, 60]")
        encoded = json.dumps(
            expected, allow_nan=False, ensure_ascii=False, separators=(",", ":")
        ).encode()
        if len(encoded) > MAX_RECORD_BYTES:
            raise ValueError("Expected native paint exceeds the record bound")
        expected = json.loads(encoded)
        if (
            not isinstance(expected, dict)
            or expected.get("type") != "rendered"
            or expected.get("stage") != "native-paint"
            or type(expected.get("window_id")) is not int
            or expected["window_id"] < 1
            or not isinstance(expected.get("nodes"), list)
            or not expected["nodes"]
        ):
            raise ValueError("Native paint observation requires a full expected tree")
        if "tree_revision" in expected and (
            type(expected["tree_revision"]) is not int or expected["tree_revision"] < 1
        ):
            raise ValueError("Expected native tree revision must be positive")
        self.path = Path(path)
        self.nonce = nonce
        self.expected = expected
        self.timeout = timeout
        self.descriptors = []
        self.thread = None
        self.begin_signal = threading.Event()
        self.ready = threading.Event()
        self.cancelled = threading.Event()
        self.done = threading.Event()
        self.started_ns = None
        self.observed = None
        self.failure = None
        self.closed = False
        self.notifications = 0
        self.records = 0
        self.pending = b""

    def __enter__(self):
        try:
            self.file = os.open(
                self.path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW
            )
            self.descriptors.append(self.file)
            info = os.fstat(self.file)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError("Native evidence must be a regular file")
            self.identity = (info.st_dev, info.st_ino)
            libc = ctypes.CDLL(None, use_errno=True)
            initialize = libc.inotify_init1
            initialize.argtypes = [ctypes.c_int]
            initialize.restype = ctypes.c_int
            self.notifications_fd = initialize(os.O_NONBLOCK | os.O_CLOEXEC)
            if self.notifications_fd < 0:
                raise OSError(ctypes.get_errno(), "Cannot create native paint inotify")
            self.descriptors.append(self.notifications_fd)
            watch = libc.inotify_add_watch
            watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            watch.restype = ctypes.c_int
            self.watch = watch(
                self.notifications_fd,
                os.fsencode(self.path),
                IN_MODIFY
                | IN_ATTRIB
                | IN_CLOSE_WRITE
                | IN_DELETE_SELF
                | IN_MOVE_SELF
                | IN_DONT_FOLLOW,
            )
            if self.watch < 0:
                raise OSError(ctypes.get_errno(), "Cannot watch native evidence file")
            self.cancel_read, self.cancel_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
            self.descriptors.extend([self.cancel_read, self.cancel_write])
            self._file_size()
            self.thread = threading.Thread(
                target=self._observe, name="native-paint-observer"
            )
            self.thread.start()
            if not self.ready.wait(1):
                raise RuntimeError("Native paint observer did not become ready")
            return self
        except BaseException:
            self.close()
            raise

    def _file_size(self):
        descriptor = os.fstat(self.file)
        path = self.path.lstat()
        if (
            not stat.S_ISREG(path.st_mode)
            or (path.st_dev, path.st_ino) != self.identity
            or (descriptor.st_dev, descriptor.st_ino) != self.identity
        ):
            raise RuntimeError("Native evidence path identity changed")
        if descriptor.st_size > MAX_LOG_BYTES:
            raise RuntimeError("Native evidence exceeded the 4 MiB limit")
        return descriptor.st_size

    def begin(self):
        if self.thread is None or self.closed or self.started_ns is not None:
            raise RuntimeError("Native paint observer is not armed exactly once")
        self.offset = self.start_offset = self._file_size()
        # A record already being written before input is ineligible, including
        # its later newline. New complete records after it remain eligible.
        self.skip_partial = bool(
            self.offset and os.pread(self.file, 1, self.offset - 1) != b"\n"
        )
        self.skipped_initial_partial = self.skip_partial
        self.anchor = os.pread(
            self.file, min(self.offset, 64), max(0, self.offset - 64)
        )
        self.started_ns = time.monotonic_ns()
        self.deadline = time.monotonic() + self.timeout
        self.begin_signal.set()
        return self.started_ns

    def _drain_notifications(self):
        while True:
            try:
                data = os.read(self.notifications_fd, 65_536)
            except BlockingIOError:
                return
            if not data:
                raise RuntimeError("Native paint notification descriptor closed")
            self.notifications += notification_count(data, self.watch)
            if self.notifications > MAX_NOTIFICATIONS:
                raise RuntimeError("Native paint notification budget exceeded")

    def _read_records(self):
        size = self._file_size()
        if size < self.offset:
            raise RuntimeError("Native evidence was truncated")
        if (
            os.pread(self.file, len(self.anchor), self.offset - len(self.anchor))
            != self.anchor
        ):
            raise RuntimeError("Native evidence previously read bytes changed")
        while self.offset < size:
            if time.monotonic() >= self.deadline:
                raise TimeoutError(
                    "Native paint observation deadline expired while reading"
                )
            data = os.pread(self.file, min(65_536, size - self.offset), self.offset)
            if not data:
                raise RuntimeError("Native evidence was truncated during observation")
            self.offset += len(data)
            self.anchor = (self.anchor + data)[-64:]
            self.pending += data
            while b"\n" in self.pending:
                line, self.pending = self.pending.split(b"\n", 1)
                if len(line) > MAX_RECORD_BYTES:
                    raise RuntimeError("Native evidence record exceeded 65,536 bytes")
                if self.skip_partial:
                    self.skip_partial = False
                    continue
                try:
                    value = json.loads(
                        line,
                        object_pairs_hook=unique_object,
                        parse_constant=invalid_constant,
                    )
                except (ValueError, UnicodeError, RecursionError) as error:
                    raise RuntimeError(
                        "Invalid complete native evidence record"
                    ) from error
                if not isinstance(value, dict) or value.get("nonce") != self.nonce:
                    raise RuntimeError("Native evidence has an invalid session nonce")
                self.records += 1
                if (
                    value.get("status") != "omitted"
                    and type(value.get("tree_revision")) is int
                    and value["tree_revision"] > 0
                    and all(
                        same_json(value.get(key), item)
                        for key, item in self.expected.items()
                    )
                    and self.observed is None
                ):
                    self.observed = {
                        "observed_ns": time.monotonic_ns(),
                        "window_id": value["window_id"],
                        "tree_revision": value["tree_revision"],
                        "record_sha256": hashlib.sha256(line + b"\n").hexdigest(),
                        "complete_expected_tree_matched": True,
                    }
            if len(self.pending) > MAX_RECORD_BYTES:
                raise RuntimeError(
                    "Native evidence unfinished record exceeded its bound"
                )
        if self._file_size() < self.offset:
            raise RuntimeError("Native evidence was truncated during observation")
        if (
            os.pread(self.file, len(self.anchor), self.offset - len(self.anchor))
            != self.anchor
        ):
            raise RuntimeError("Native evidence previously read bytes changed")

    def _observe(self):
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(self.notifications_fd, selectors.EVENT_READ)
                selector.register(self.cancel_read, selectors.EVENT_READ)
                self.ready.set()
                self.begin_signal.wait(self.timeout)
                if self.cancelled.is_set():
                    return
                if self.started_ns is None:
                    raise RuntimeError("Native paint observation was never started")
                while not self.cancelled.is_set():
                    remaining = self.deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Native paint observation deadline expired")
                    available = selector.select(remaining)
                    if self.cancelled.is_set():
                        return
                    if not available:
                        raise TimeoutError("Native paint observation deadline expired")
                    self._drain_notifications()
                    self._read_records()
                    if self.observed is not None:
                        return
        except BaseException as error:
            self.failure = error
        finally:
            self.done.set()

    def result(self, command_completed_ns):
        if self.started_ns is None:
            raise RuntimeError("Native paint observation was not started")
        self.done.wait(max(0, self.deadline - time.monotonic()) + 0.1)
        if self.failure is not None:
            raise self.failure
        if self.observed is None:
            raise TimeoutError("Native paint observation did not complete")
        observed_ns = self.observed["observed_ns"]
        if command_completed_ns < self.started_ns or observed_ns < self.started_ns:
            raise RuntimeError("Native paint observation clock order is invalid")
        return {
            "method": "Linux inotify with concurrent bounded JSONL reader",
            "clock": "Python time.monotonic_ns",
            "start": "immediately before the first OS input command, after its focus/geometry preparation",
            "end": "complete matching native paint record read and validated",
            "scope": "command start to paint-record observation; includes process, scheduling and log I/O overhead; not OS delivery or display presentation",
            "command_start_to_paint_observed_ms": (observed_ns - self.started_ns)
            / 1_000_000,
            "command_start_to_input_commands_returned_ms": (
                command_completed_ns - self.started_ns
            )
            / 1_000_000,
            "observed_before_input_commands_returned": observed_ns
            < command_completed_ns,
            "file_identity": {"device": self.identity[0], "inode": self.identity[1]},
            "start_byte_offset": self.start_offset,
            "read_byte_offset": self.offset,
            "ignored_preexisting_partial_record": self.skipped_initial_partial,
            "validated_records": self.records,
            "notifications": self.notifications,
            "paint": {
                key: value
                for key, value in self.observed.items()
                if key != "observed_ns"
            },
        }

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.cancelled.set()
        self.begin_signal.set()
        if hasattr(self, "cancel_write"):
            try:
                os.write(self.cancel_write, b"x")
            except (BlockingIOError, OSError):
                pass
        if self.thread is not None:
            self.thread.join(timeout=2)
        for descriptor in reversed(self.descriptors):
            os.close(descriptor)
        self.descriptors.clear()
        if self.thread is not None and self.thread.is_alive():
            raise RuntimeError("Native paint reader did not stop during cleanup")

    def __exit__(self, *_exception):
        self.close()

"""Private macOS CEF shutdown diagnostic, using the ordinary bounded observer.

The caller supplies an independently signed private app containing its workload.
Thread-state reads are diagnostics, never performance passes or stack captures.
No debugger, suspension, signal, runtime flag, deadline, or cleanup change is used.
"""

import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
import struct
import sys
import threading
import time
from pathlib import Path

import psutil
from macos_clone_cleanup import executable_digest
from macos_sandbox import presence

# XNU proc_info.h: PROC_PIDLISTTHREADS=6, PROC_PIDTHREADINFO=5;
# proc_threadinfo is two uint64_t, eight int32_t, and a 64-byte name (112 bytes).
# These thread handles are not the thread_id values accepted by flavor 15.
THREAD_LIMIT = 256


def decode_thread_info(data):
    if len(data) != 112:
        raise ValueError("short-thread-info")
    user, system, _cpu, _policy, state, flags, sleep, _current, _priority, _max, name = (
        struct.unpack("=QQ8i64s", data)
    )
    if state not in range(1, 6):
        raise ValueError("unknown-thread-state")
    return {
        "userTime": user,
        "systemTime": system,
        "runState": state,
        "flags": flags,
        "sleepTime": sleep,
        "name": name.split(b"\0", 1)[0].decode("utf-8", errors="replace"),
    }


def read_threads(pid):
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    call = library.proc_pidinfo
    call.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    call.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer((THREAD_LIMIT + 1) * 8)
    size = call(pid, 6, 0, buffer, len(buffer))
    if size <= 0 or size % 8 or size > THREAD_LIMIT * 8:
        raise ValueError("thread-inventory-unavailable-or-overfull")
    handles = struct.unpack("=" + str(size // 8) + "Q", buffer.raw[:size])
    if len(set(handles)) != len(handles) or any(handle == 0 for handle in handles):
        raise ValueError("invalid-thread-inventory")
    result = []
    for handle in handles:
        info = ctypes.create_string_buffer(112)
        size = call(pid, 5, handle, info, len(info))
        if size != 112:
            # Thread exit races are unavailable reads, never fabricated zeroes.
            result.append({"handle": handle, "unavailable": True})
        else:
            result.append({"handle": handle, **decode_thread_info(info.raw)})
    return result


def root_executable_matches(tracker, actual, expected):
    stamp, digest = executable_digest(expected)
    if stamp[:2] != tracker.main_identity or digest != tracker.main_hash:
        return False
    if actual == expected:
        return True
    # Chromium can execute a signing clone hard-linked to this private host.
    # A different path, same name, or even identical bytes alone is insufficient.
    stamp, digest = executable_digest(actual)
    return stamp[:2] == tracker.main_identity and digest == tracker.main_hash


def verified_target(tracker, app, role):
    """Require both live ancestry and kernel original-parent identity."""
    if role not in ("host", "network"):
        raise ValueError("unsupported-capture-role")
    if tracker is None or tracker.invalid or tracker.root_kernel is None:
        raise ValueError("unverified-owned-root")
    root = psutil.Process(tracker.root_pid)
    mismatches = {
        "birth": root.create_time() != tracker.root_birth,
        "kernel": tracker.kernel.identity(root.pid) != tracker.root_kernel,
        "executable": not root_executable_matches(
            tracker, Path(root.exe()), app / "Contents/MacOS/bunly_host"
        ),
        "uid": root.uids().real != os.getuid(),
    }
    if any(mismatches.values()):
        raise ValueError(
            "root-identity-changed:" + ",".join(key for key, bad in mismatches.items() if bad)
        )
    candidates = [root] if role == "host" else root.children()
    matches = []
    for proc in candidates:
        try:
            identity = tracker.kernel.identity(proc.pid)
            path = Path(proc.exe())
            if role == "network" and (
                proc.ppid() != root.pid
                or identity is None
                or identity.parent_unique_id != tracker.root_kernel.unique_id
                or path
                != app
                / "Contents/Frameworks/bunly_host Helper.app/Contents/MacOS/bunly_host Helper"
                or "--utility-sub-type=network.mojom.NetworkService" not in proc.cmdline()
            ):
                continue
            if proc.uids().real != os.getuid() or identity is None:
                continue
            stamp, digest = executable_digest(path)
            # Do not trust a replacement at the expected pathname merely because
            # it is stable across snapshots. CloneCleanup pinned this helper
            # before Popen, independently of role selection and capture timing.
            if role == "network" and (
                path != tracker.helper
                or stamp != tracker.helper_stamp
                or digest != tracker.helper_hash
            ):
                raise ValueError("helper-changed-since-launch")
            birth = proc.create_time()
            if tracker.kernel.identity(proc.pid) != identity:
                raise ValueError("target-identity-changed")
            matches.append((proc.pid, birth, identity, path, stamp, digest))
        except psutil.NoSuchProcess:
            continue
    if len(matches) != 1:
        raise ValueError("no-unique-owned-target")
    return matches[0]


class Capture:
    def __init__(self, app, output, role, after):
        self.app, self.output, self.role, self.after = app, output, role, after
        self.started = time.monotonic()
        self.worker = None
        self.records = []
        self.stop = threading.Event()

    def __call__(self, tracker):
        if self.worker is None and time.monotonic() - self.started >= self.after:
            # Read-only diagnostics must not keep the command alive after its
            # bounded join expires. No application ownership lives in this worker.
            self.worker = threading.Thread(target=self.run, args=(tracker,), daemon=True)
            self.worker.start()

    def run(self, tracker):
        try:
            target = verified_target(tracker, self.app, self.role)
            for index in range(10):
                if self.stop.is_set():
                    raise ValueError("capture-cancelled")
                if verified_target(tracker, self.app, self.role) != target:
                    raise ValueError("target-replaced-before-capture")
                record = {
                    "index": index,
                    "elapsedMs": (time.monotonic() - self.started) * 1000,
                    "pid": target[0],
                    "birth": target[1],
                    "kernelUniqueId": target[2].unique_id,
                    "executableUuid": target[2].executable_uuid.hex(),
                    "executableSha256": target[5],
                }
                self.records.append(record)
                (self.output / "capture-ledger.json").write_text(
                    json.dumps(self.records, indent=2) + "\n"
                )
                record["threads"] = read_threads(target[0])
                if self.stop.is_set():
                    raise ValueError("capture-cancelled")
                if verified_target(tracker, self.app, self.role) != target:
                    raise ValueError("target-replaced-after-capture")
                record["identityRevalidated"] = True
                if index < 9:
                    self.stop.wait(0.25)
        except (OSError, ValueError, psutil.Error) as error:
            self.records.append({"failure": type(error).__name__ + ": " + str(error)})


def finish_capture(capture, timeout=12):
    """Never qualify partial snapshots or read worker-owned records before join."""
    if capture is None:
        return {"schema": 1, "status": "disabled", "captureComplete": False, "records": []}
    if capture.worker is None:
        return {"schema": 1, "status": "not-started", "captureComplete": False, "records": []}
    capture.worker.join(timeout=timeout)
    if capture.worker.is_alive():
        capture.stop.set()
        # The pre-read ledger remains available. Do not race the worker while
        # serializing records or pretend incomplete data is a qualified capture.
        return {
            "schema": 1,
            "status": "worker-did-not-settle",
            "captureComplete": False,
            "records": [],
        }
    complete = len(capture.records) == 10 and all(
        row.get("identityRevalidated") is True and row.get("index") == index
        for index, row in enumerate(capture.records)
    )
    return {
        "schema": 1,
        "status": "complete" if complete else "incomplete",
        "captureComplete": complete,
        "records": capture.records,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--role", choices=["control", "host", "network"], default="control")
    parser.add_argument("--after", type=float, default=40)
    parser.add_argument("--mode", choices=["visible", "hidden"], default="visible")
    args = parser.parse_args()
    if sys.platform != "darwin" or not 0 <= args.after <= 50:
        parser.error("Requires macOS and a finite capture offset from 0 to 50 seconds")
    app = args.app.resolve(strict=True)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    output = args.output.resolve()
    executable = app / "Contents/MacOS/bunly_host"
    executable_digest(executable)
    identities = {}
    for path in [
        executable,
        app
        / "Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
    ]:
        with path.open("rb") as stream:
            identities[str(path.relative_to(app))] = hashlib.file_digest(
                stream, "sha256"
            ).hexdigest()
    (output / "input.json").write_text(
        json.dumps(
            {
                "binarySha256": identities,
                "captureSourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            },
            indent=2,
        )
        + "\n"
    )
    os.environ.update(
        {
            "BUNLY_CACHE_DIR": str(output / "cache"),
            "BUNLY_TERMINAL_LOAD_MODE": args.mode,
            "BUNLY_TERMINAL_LOAD_OUTPUT": str(output / "workload.jsonl"),
        }
    )
    spec = importlib.util.spec_from_file_location(
        "observer", Path(__file__).with_name("observe-process.py")
    )
    observer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observer)
    capture = None if args.role == "control" else Capture(app, output, args.role, args.after)
    result = observer.observe(
        [str(executable)], timeout=90, sandbox_reader=presence, cleanup_observer=capture
    )
    # Preserve the ordinary observer result even if diagnostic completion fails.
    (output / "process.json").write_text(json.dumps(result, indent=2) + "\n")
    captured = finish_capture(capture)
    (output / "capture.json").write_text(
        json.dumps(
            {
                "classification": "no-stack-sampling"
                if capture is None
                else "read-only-thread-state",
                "role": args.role,
                "after": args.after,
                **captured,
            },
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps(
            {
                "exitCode": result["exitCode"],
                "captureStatus": captured["status"],
                "output": str(output),
            }
        )
    )
    # This status is diagnostic completion only; process.json remains authoritative
    # for the separate application/workload/cleanup outcome.
    return 0 if captured["status"] in ("disabled", "complete") else 1


if __name__ == "__main__":
    sys.exit(main())

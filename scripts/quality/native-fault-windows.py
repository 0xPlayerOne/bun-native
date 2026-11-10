"""Windows native fault containment for the real GPUI host (issue #247).

The Windows counterpart of native-fault-macos.py. tests/native/fault.ts
(`host-crash`) runs unchanged: a real SendInput click on the owned window parks
a public callback, every thread of the owned host is suspended
(NtSuspendProcess), two batches queue behind it, then the host is terminated
(TerminateProcess) with FAULT_EXIT_CODE. The fixture proves one shared
transport failure, an aborted callback, zero ownership and the exit code the
controller chose. The host is found and its identity (PID, creation time,
image path) checked by native-platform-windows.py; the controller then holds
its own handle, so a reused PID can never be suspended or terminated.
Startup failure by invalid display has no Windows equivalent and is not
claimed.

SDK contracts:
https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess
https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess
"""

import argparse
import ctypes as c
import importlib.util
import json
import logging
import os
import platform
import secrets
import subprocess
import threading
import time
from pathlib import Path

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]
TITLE = "Bun Native native fault"
# Must match tests/native/fault.ts. Distinct from every code the host or the
# Windows loader reports on its own.
FAULT_EXIT_CODE = 0x0BAD
PROCESS_TERMINATE = 0x0001
PROCESS_SUSPEND_RESUME = 0x0800
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x100000
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DIAGNOSTICS = load("native_diagnostics", "scripts/quality/native-diagnostics-linux.py")
EVIDENCE = DIAGNOSTICS.DRIVER
OS_INPUT = load("native_platform_input", "scripts/quality/native-platform-input.py")
WINDOWS = load("native_platform_windows", "scripts/quality/native-platform-windows.py")


class HostControl:
    """Suspend and terminate rights on the one host the input driver verified."""

    def __init__(self, driver):
        self.driver = driver
        self.kernel = driver.kernel
        self.kernel.TerminateProcess.argtypes = [WINDOWS.HANDLE, c.c_uint]
        self.kernel.TerminateProcess.restype = WINDOWS.BOOL
        self.kernel.GetExitCodeProcess.argtypes = [
            WINDOWS.HANDLE,
            c.POINTER(WINDOWS.DWORD),
        ]
        self.kernel.GetExitCodeProcess.restype = WINDOWS.BOOL
        host = driver.host
        handle = self.kernel.OpenProcess(
            PROCESS_TERMINATE
            | PROCESS_SUSPEND_RESUME
            | PROCESS_QUERY_LIMITED_INFORMATION
            | SYNCHRONIZE,
            False,
            host["pid"],
        )
        if not handle:
            raise OSError(c.get_last_error(), "Cannot open the native host for control")
        self.handle = handle
        # The new handle names the same process the driver verified, or the
        # host already exited and its PID was reused.
        identity = driver._identity(handle, host["pid"])
        if any(identity[key] != host[key] for key in identity):
            self.close()
            raise RuntimeError("Native host identity changed before control")
        self.identity = identity

    def verify(self):
        self.driver._verify_process(self.driver.app)
        if self.driver._identity(self.handle, self.identity["pid"]) != self.identity:
            raise RuntimeError("Native host identity changed")
        return dict(self.identity)

    def suspend(self):
        # Undocumented but stable since Windows XP; it suspends every thread,
        # which SuspendThread cannot do atomically for a running process.
        ntdll = c.WinDLL("ntdll")
        ntdll.NtSuspendProcess.argtypes = [WINDOWS.HANDLE]
        ntdll.NtSuspendProcess.restype = c.c_int32
        status = ntdll.NtSuspendProcess(self.handle)
        if status != 0:
            raise OSError(status & 0xFFFFFFFF, "NtSuspendProcess failed")

    def terminate(self):
        if not self.kernel.TerminateProcess(self.handle, FAULT_EXIT_CODE):
            raise OSError(c.get_last_error(), "TerminateProcess failed")

    def exit_code(self):
        """The host's exit code once it has exited, else None."""
        if self.kernel.WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT:
            return None
        code = WINDOWS.DWORD()
        if not self.kernel.GetExitCodeProcess(self.handle, c.byref(code)):
            raise OSError(c.get_last_error(), "GetExitCodeProcess failed")
        return code.value

    def exited(self):
        """{"code": n} once the host has exited (0 is a code, not "running")."""
        code = self.exit_code()
        return None if code is None else {"code": code}

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("development", "aot"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    host = Path(os.environ.get("BUN_NATIVE_HOST", ""))
    if platform.system() != "Windows":
        parser.error("This driver requires Windows")
    if not command or not host.is_absolute() or not host.is_file():
        parser.error("Supply a fixture command and absolute prebuilt BUN_NATIVE_HOST")
    host = host.resolve()
    args.output.mkdir()
    output = args.output.resolve()
    nonce = secrets.token_hex(16)
    report = {
        "schemaVersion": 1,
        "status": "failed",
        "scenario": "host-crash",
        "platform": "windows",
        "mode": args.mode,
        "host": {"path": str(host), **DIAGNOSTICS.fingerprint(host)},
        "command": command,
        "system": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "windows": platform.version(),
        },
        "sourceFiles": {
            relative: DIAGNOSTICS.fingerprint(ROOT / relative)
            for relative in (
                "tests/native/fault.ts",
                "scripts/quality/native-fault-windows.py",
                "scripts/quality/native-platform-windows.py",
            )
        },
        "scope": "Actual GPUI host on Windows: a real SendInput click parks a public callback, the owned host is suspended then terminated with two queued batches. Transport failure containment only; a GPUI-internal panic, crash dumps and startup failure by invalid display are not covered.",
        "faultExitCode": FAULT_EXIT_CODE,
        "actions": [],
        "logs": {},
    }
    environment = {
        **os.environ,
        "BUN_NATIVE_HOST": str(host),
        "BUN_NATIVE_DIAGNOSTICS_DIR": str(output),
        "BUN_NATIVE_DIAGNOSTICS_SCENARIO": "host-crash",
        "BUN_NATIVE_EVIDENCE_LOG": str(output / "native.jsonl"),
        "BUN_NATIVE_EVIDENCE_NONCE": nonce,
        "BUN_NATIVE_FAULT_OS_CLICK": "1",
    }
    started = time.monotonic()
    threads = []
    app = None
    driver = None
    control = None

    def records(name):
        return EVIDENCE.read_events(output / name, nonce, 0)

    def wait_for(predicate, description, timeout=10):
        deadline = min(started + 40, time.monotonic() + timeout)
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            if app.poll() is not None:
                value = predicate()
                if value:
                    return value
                raise RuntimeError(
                    f"Fixture exited {app.returncode} before {description}"
                )
            time.sleep(0.02)
        raise RuntimeError("Timed out waiting for " + description)

    def application_record(kind):
        return next(
            (row for row in records("application.jsonl") if row.get("type") == kind),
            None,
        )

    try:
        app = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        for name, stream in (("stdout", app.stdout), ("stderr", app.stderr)):
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            report["logs"][name] = stats
            thread = threading.Thread(
                target=EVIDENCE.capture,
                args=(stream, output / (name + ".log"), stats),
                daemon=True,
            )
            thread.start()
            threads.append(thread)
        mounted = wait_for(lambda: application_record("mounted"), "mounted native tree")
        driver = WINDOWS.WindowsInput(app.pid, host)
        report["osObservation"] = dict(
            wait_for(
                lambda: driver.observe(TITLE),
                "independently owned and visible native window",
            )
        )
        layout = wait_for(
            lambda: next(
                (
                    row["layout"]
                    for row in reversed(records("native.jsonl"))
                    if row.get("type") == "layout"
                    and row.get("tree_revision", 1) >= mounted.get("treeRevision", 1)
                    and row["layout"].get("status") == "complete"
                ),
                None,
            ),
            "actual native input geometry",
        )
        button = max(layout["nodes"], key=lambda node: node["node_id"])
        x, y, viewport = OS_INPUT.pointer_target(layout, button["node_id"])
        report["pointerTarget"] = {"nodeId": button["node_id"], "point": [x, y]}
        report["pointer"] = driver.click(x, y, viewport)
        report["launchCallback"] = wait_for(
            lambda: application_record("callback-waiting"), "real OS-click callback"
        )
        control = HostControl(driver)
        report["actions"].append({**control.verify(), "action": "NtSuspendProcess"})
        control.suspend()
        (output / "queue-after-stop").touch()
        pending = wait_for(
            lambda: application_record("pending"), "pending application work"
        )
        ownership = pending.get("ownership", {})
        if (
            ownership.get("queuedTransactions") != 2
            or ownership.get("activeCallbacks") != 1
        ):
            raise RuntimeError(
                "The transaction/callback fault preconditions were not established"
            )
        report["actions"].append({**control.verify(), "action": "TerminateProcess"})
        control.terminate()
        report["hostExitCode"] = wait_for(control.exited, "terminated native host", 5)[
            "code"
        ]
        if report["hostExitCode"] != FAULT_EXIT_CODE:
            raise RuntimeError(
                f"The native host exited {report['hostExitCode']}, not the injected fault"
            )
        report["containment"] = wait_for(
            lambda: application_record("crash-contained"),
            "precise native fault containment",
        )
        wait_for(lambda: app.poll() is not None, "fixture exit", timeout=10)
        if app.returncode != 0:
            raise RuntimeError(f"The fault fixture exited {app.returncode}")
        report["status"] = "passed"
    except Exception as error:
        LOGGER.exception("Windows native fault failed")
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if app is not None:
            if app.poll() is None:
                (output / "abort").touch()
                try:
                    app.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    app.kill()
                    app.wait(timeout=3)
                    report["status"] = "failed"
            report["applicationExitCode"] = app.returncode
        if control is not None:
            # A host left suspended by a failed run must not outlive it.
            if control.exit_code() is None:
                control.terminate()
                report["status"] = "failed"
            control.close()
        if driver is not None:
            driver.close()
        for thread in threads:
            thread.join(timeout=1)
        if any(stats["discarded_bytes"] for stats in report["logs"].values()):
            report["status"] = "failed"
        result = output / "application-result.json"
        if result.exists():
            report["application"] = json.loads(result.read_text(encoding="utf-8"))
        if (
            report["status"] == "passed"
            and report.get("application", {}).get("status") != "passed"
        ):
            report["status"] = "failed"
        (output / "result.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
    print(
        json.dumps(
            {
                "status": report["status"],
                "mode": args.mode,
                "report": str(output / "result.json"),
                "error": report.get("error"),
            }
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

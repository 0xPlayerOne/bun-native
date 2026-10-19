"""Verify one fixture-reported PID against an exact installed executable, then await exit.

This supplements, not replaces, descendant sampling across Launch Services handoff.
No arbitrary process discovery or termination is performed.
"""

import argparse
import json
import time
from pathlib import Path

import psutil


def verify(pid, executable):
    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1:
        raise ValueError("Invalid registered PID")
    expected = Path(executable).resolve(strict=True)
    process = psutil.Process(pid)
    created = process.create_time()
    if Path(process.exe()).resolve(strict=True) != expected:
        raise ValueError("Registered process executable mismatch")
    if process.create_time() != created or not process.is_running():
        raise ValueError("Registered process identity changed")
    return process, created


def wait_for_exit(process, created, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if process.create_time() != created:
                raise ValueError("Registered PID reused")
            if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
                return True
        except psutil.NoSuchProcess:
            return True
        time.sleep(0.025)
    return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("pid", type=int)
    parser.add_argument("executable")
    parser.add_argument("--timeout", type=float, default=35)
    args = parser.parse_args()
    if not 0 < args.timeout <= 120:
        parser.error("Invalid deadline")
    proc, creation = verify(args.pid, args.executable)
    print(
        json.dumps(
            {
                "event": "registered-app",
                "pid": proc.pid,
                "creationTime": creation,
                "executableMatched": True,
            }
        ),
        flush=True,
    )
    passed = wait_for_exit(proc, creation, args.timeout)
    print(
        json.dumps(
            {
                "event": "registered-app-exit",
                "pid": proc.pid,
                "creationTime": creation,
                "exited": passed,
            }
        ),
        flush=True,
    )
    raise SystemExit(0 if passed else 1)

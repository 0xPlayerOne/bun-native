"""Real pinned-Bun Unix owner qualification, with exact fixture identity cleanup."""

import argparse
import hashlib
import json
import os
import platform
import select
import socket
import subprocess
import sys
import time
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parents[1]


def read_record(process, timeout=8):
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise AssertionError("Fixture notification deadline exceeded")
    line = process.stdout.readline()
    if not line:
        raise AssertionError(f"Fixture exited before notification: {process.stderr.read()!r}")
    return json.loads(line)


def live(process):
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def await_gone(owned, timeout=5):
    end = time.monotonic() + timeout
    # Qualification-only observation. Runtime uses fd notification and waitid.
    while time.monotonic() < end:
        if not any(live(process) for process in owned):
            return True
        time.sleep(0.02)
    return False


def run_case(bun, owner, mode):
    report = {"case": mode, "passed": False, "harnessCleanup": []}
    owned = []
    backend = None
    unrelated = None
    try:
        # Identical shell/server argv, explicitly independent session and lifetime.
        argv = [
            "/bin/sh",
            "-c",
            'trap "" HUP TERM; exec 9<&0; "$1" "$2" <&9 & wait $!',
            "bunly-owned-shell",
            sys.executable,
            str(ROOT / "tests/fixtures/terminal-owner-server.py"),
        ]
        unrelated = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        unrelated_identity = psutil.Process(unrelated.pid)
        owned.append(unrelated_identity)
        unrelated_record = read_record(unrelated)
        independent = [unrelated_identity, psutil.Process(unrelated_record["server"])]
        owned.append(independent[1])
        backend = subprocess.Popen(
            [bun, str(ROOT / "tests/fixtures/terminal-owner-backend.ts"), owner, sys.executable],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        backend_identity = psutil.Process(backend.pid)
        owned.append(backend_identity)
        record = read_record(backend)
        shell = psutil.Process(record["shell"])
        server = psutil.Process(record["server"])
        helper = shell.parent()
        assert helper is not None
        # Capture exact OS creation identities and ancestry before any signal.
        assert helper.ppid() == backend.pid and server.ppid() == shell.pid
        assert os.getpgid(shell.pid) == shell.pid == record["group"]
        assert os.getpgid(helper.pid) != shell.pid
        assert record["controlInherited"] is False
        descendants = [helper, shell, server]
        owned.extend(descendants)
        report["identities"] = [{"pid": p.pid, "created": p.create_time()} for p in owned]
        with socket.create_connection(("127.0.0.1", record["port"]), timeout=2):
            pass
        if mode == "kill-backend":
            backend_identity.kill()
        else:
            backend.stdin.write((mode + "\n").encode())
            backend.stdin.flush()
        if mode in ("close", "cancel", "natural"):
            result = read_record(backend)
            report["result"] = result
            assert result["process"]["observed"] and not result["process"]["waitError"]
            if mode == "natural":
                assert result["process"]["exitCode"] == 7 and result["final"]
                assert result["output"] == {"ok": True}
            else:
                assert all(result["result"].values())
        backend.wait(timeout=8)
        report["backendExit"] = backend.returncode
        assert backend.returncode == {"exit-backend": 23, "kill-backend": -9}.get(mode, 0)
        assert await_gone(descendants), "Owned descendant survived owner cleanup"
        assert all(live(p) for p in independent), "Unrelated identical command was stopped"
        try:
            with socket.create_connection(("127.0.0.1", record["port"]), timeout=0.2):
                raise AssertionError("Owned server port remained open")
        except ConnectionRefusedError:
            pass
        report["passed"] = True
    except Exception as error:
        report["failure"] = str(error)
        # Startup failures may precede the ready record. Capture descendants of
        # only these exclusively owned fixture roots before cleanup signals.
        for root in list(owned):
            if live(root):
                for child in root.children(recursive=True):
                    if child not in owned:
                        owned.append(child)
    finally:
        # psutil Process retains the captured creation identity on signal APIs.
        # Never discover names/PIDs during cleanup or signal unrecorded processes.
        for process in reversed(owned):
            if live(process):
                report["harnessCleanup"].append(process.pid)
                process.kill()
        if backend is not None:
            backend.wait(timeout=5)
        if unrelated is not None:
            unrelated.wait(timeout=5)
        if not await_gone(owned):
            report["passed"] = False
            report["cleanupFailure"] = True
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if sys.platform not in ("darwin", "linux"):
        parser.error("Unix owner is unsupported on this platform")
    results = [
        run_case(args.bun, str(Path(args.owner).resolve(strict=True)), mode)
        for mode in ("natural", "close", "cancel", "exit-backend", "kill-backend")
    ]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "source": subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
                ).strip(),
                "platform": sys.platform,
                "machine": platform.machine(),
                "bunVersion": subprocess.check_output([args.bun, "--version"], text=True).strip(),
                "ownerSha256": hashlib.sha256(Path(args.owner).read_bytes()).hexdigest(),
                "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
                "results": results,
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps(results, indent=2))
    return 0 if all(result["passed"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

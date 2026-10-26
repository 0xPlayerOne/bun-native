"""Real native-host/Bun/terminal qualification with bounded receipts and owned cleanup."""

import argparse
import ctypes
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
    """Read exactly one bounded frame; partial input never resets the deadline."""
    deadline = time.monotonic() + timeout
    frame = bytearray()
    fd = process.stdout.fileno()
    if sys.platform != "win32":
        os.set_blocking(fd, False)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("fixture-notification-deadline")
        if sys.platform == "win32":
            import msvcrt

            available = ctypes.c_ulong()
            if not ctypes.windll.kernel32.PeekNamedPipe(
                ctypes.c_void_p(msvcrt.get_osfhandle(fd)),
                None,
                0,
                None,
                ctypes.byref(available),
                None,
            ):
                raise AssertionError("fixture-notification-eof")
            if not available.value:
                time.sleep(min(remaining, 0.005))
                continue
        else:
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                raise AssertionError("fixture-notification-deadline")
        try:
            byte = os.read(fd, 1)
        except BlockingIOError:
            continue
        if not byte:
            raise AssertionError("fixture-notification-eof")
        if byte == b"\n":
            try:
                value = json.loads(frame)
            except (ValueError, UnicodeError) as error:
                raise AssertionError("fixture-notification-malformed") from error
            if not isinstance(value, dict):
                raise AssertionError("fixture-notification-not-object")
            return value
        frame.extend(byte)
        if len(frame) >= 16384:
            raise AssertionError("fixture-notification-oversized")


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


def run_case(bun, owner, host, mode):
    report = {"case": mode, "passed": False, "harnessCleanup": []}
    owned = []
    backend = None
    unrelated = None
    permitted_cleanup = {0, 1}
    try:
        # Identical shell/server argv, explicitly independent session and lifetime.
        argv = [
            "/bin/sh",
            "-c",
            'trap "" HUP TERM; exec 9<&0; "$1" "$2" "$3" <&9 & wait $!',
            "bunly-owned-shell",
            sys.executable,
            str(ROOT / "tests/fixtures/terminal-owner-server.py"),
            "",
        ]
        if sys.platform == "win32":
            argv = [
                os.environ["COMSPEC"],
                "/d",
                "/s",
                "/c",
                str(ROOT / "tests/fixtures/terminal-owner-shell.cmd"),
            ]
        unrelated = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            env={**os.environ, "BUNLY_OWNER_FIXTURE_PYTHON": sys.executable},
        )
        unrelated_identity = psutil.Process(unrelated.pid)
        owned.append(unrelated_identity)
        report["stage"] = "independent-shell-readiness"
        unrelated_record = read_record(unrelated)
        independent = [unrelated_identity, psutil.Process(unrelated_record["server"])]
        owned.append(independent[1])
        backend = subprocess.Popen(
            [
                host,
                bun,
                str(ROOT / "tests/fixtures/terminal-owner-backend.ts"),
                owner,
                sys.executable,
            ],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        native_host = psutil.Process(backend.pid)
        owned.append(native_host)
        report["stage"] = "native-owned-shell-readiness"
        record = read_record(backend)
        backend_identity = psutil.Process(record["backend"])
        owned.append(backend_identity)
        shell = psutil.Process(record["shell"])
        server = psutil.Process(record["server"])
        helper = shell.parent()
        assert helper is not None
        # Capture exact OS creation identities and ancestry before any signal.
        assert helper.ppid() == backend_identity.pid and server.ppid() == shell.pid
        assert backend_identity.ppid() == native_host.pid
        if sys.platform != "win32":
            assert os.getpgid(shell.pid) == shell.pid == record["group"]
            assert os.getpgid(helper.pid) != shell.pid
            assert record["controlInherited"] is False
            assert record["hostInherited"] is False
        assert record["emptyArgPreserved"] is True
        descendants = [helper, shell, server]
        owned.extend(descendants)
        report["identitiesCaptured"] = len(owned)
        ledger = (
            ROOT
            / ".bunly/supervision-evidence"
            / ("private-identities-" + str(time.time_ns()) + ".json")
        )
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text(json.dumps([{"pid": p.pid, "created": p.create_time()} for p in owned]))
        with socket.create_connection(("127.0.0.1", record["port"]), timeout=2):
            pass
        report["stage"] = "owned-lifecycle"
        if mode == "kill-guardian":
            helper.kill()
            if sys.platform == "win32":
                assert await_gone([shell, server]), "terminal-job-survived-guardian-loss"
            else:
                report["descendantsGoneAfterGuardianKill"] = await_gone([shell, server], 0.2)
                report["unsupported"] = "guardian-SIGKILL-can-orphan-nondetaching-group"
                permitted_cleanup.update((5, 6))
            backend.stdin.write(b"exit-backend\n")
            backend.stdin.flush()
        elif mode in ("host-quit", "kill-host"):
            backend.stdin.write(b"hang-backend\n")
            backend.stdin.flush()
            assert read_record(backend) == {"event": "hung"}
            if mode == "host-quit":
                backend.stdin.write(b"host-quit\n")
                backend.stdin.flush()
            else:
                native_host.kill()
        elif mode == "kill-backend":
            backend_identity.kill()
        else:
            backend.stdin.write((mode + "\n").encode())
            backend.stdin.flush()
        if mode in ("host-quit", "kill-host"):
            assert await_gone(descendants), "owned-descendant-survived-host-loss"
            if sys.platform != "win32":
                assert live(backend_identity), "backend-must-remain-alive-during-host-loss"
                permitted_cleanup.add(3)  # deliberately hung Bun; terminals must already be gone
            else:
                assert await_gone([backend_identity]), "backend-survived-native-Job-close"
        if mode in ("close", "cancel", "natural"):
            result = read_record(backend)
            report["result"] = result
            assert result["process"]["observed"] and not result["process"]["waitError"]
            if mode == "natural":
                assert result["process"]["exitCode"] == 7 and result["final"]
                assert result["output"] == {"ok": True}
            else:
                assert all(result["result"].values())
        if mode not in ("host-quit", "kill-host"):
            exit_record = read_record(backend)
            assert exit_record["event"] == "backend-exited"
            report["backendExit"] = exit_record["code"]
            assert report["backendExit"] == {
                "exit-backend": 23,
                "kill-backend": 1 if sys.platform == "win32" else 137,
                "kill-guardian": 23,
            }.get(mode, 0)
            if "unsupported" not in report:
                assert await_gone(descendants), "owned-descendant-survived-backend-lease-loss"
            assert live(native_host), "native-host-must-remain-alive-for-backend-loss-check"
            backend.stdin.write(b"host-quit\n")
            backend.stdin.flush()
        backend.wait(timeout=8)
        report["hostExit"] = backend.returncode
        assert backend.returncode == (
            (1 if sys.platform == "win32" else -9) if mode == "kill-host" else 0
        )
        if "unsupported" not in report:
            assert await_gone(descendants), "Owned descendant survived owner cleanup"
        assert all(live(p) for p in independent), "Unrelated identical command was stopped"
        try:
            with socket.create_connection(("127.0.0.1", record["port"]), timeout=0.2):
                report["serverPortClosed"] = False
        except ConnectionRefusedError:
            report["serverPortClosed"] = True
        if "unsupported" not in report:
            assert report["serverPortClosed"], "owned-server-port-remained-open"
        report["passed"] = "unsupported" not in report
        report["boundaryObserved"] = True
    except Exception as error:
        report["failure"] = type(error).__name__
        report["failureCode"] = str(error) if isinstance(error, AssertionError) else "fixture-error"
        if backend is not None and backend.stderr is not None and sys.platform != "win32":
            try:
                os.set_blocking(backend.stderr.fileno(), False)
                diagnostic = os.read(backend.stderr.fileno(), 16384)
                destination = (
                    ROOT
                    / ".bunly/supervision-evidence"
                    / ("private-" + str(time.time_ns()) + ".log")
                )
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(diagnostic)
            except OSError:
                report["diagnosticUnavailable"] = True
        # Startup failures may precede the ready record. Capture descendants of
        # only these exclusively owned fixture roots before cleanup signals.
        for root in list(owned):
            try:
                if live(root):
                    for child in root.children(recursive=True):
                        if child not in owned:
                            owned.append(child)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                report["discoveryFailure"] = True
    finally:
        # psutil Process retains the captured creation identity on signal APIs.
        # Never discover names/PIDs during cleanup or signal unrecorded processes.
        for index, process in reversed(list(enumerate(owned))):
            try:
                if live(process):
                    report["harnessCleanup"].append(index)
                    if index not in permitted_cleanup:
                        report["passed"] = False
                        report["unexpectedCleanup"] = True
                    process.kill()
            except Exception as error:
                report["passed"] = False
                report.setdefault("cleanupFailures", []).append(type(error).__name__)
        for child in (backend, unrelated):
            if child is not None:
                try:
                    child.wait(timeout=5)
                except Exception as error:
                    report["passed"] = False
                    report.setdefault("cleanupFailures", []).append(type(error).__name__)
        try:
            if not await_gone(owned):
                report["passed"] = False
                report["cleanupFailure"] = True
        except Exception:
            report["passed"] = False
            report["cleanupFailure"] = True
    return report


def run_spawn_failure(bun, owner, host):
    report = {"case": "spawn-failure", "passed": False, "harnessCleanup": []}
    child = None
    identity = None
    try:
        child = subprocess.Popen(
            [
                host,
                bun,
                str(ROOT / "tests/fixtures/terminal-owner-backend.ts"),
                owner,
                sys.executable,
            ],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "BUNLY_FIXTURE_SCENARIO": "spawn-failure"},
        )
        identity = psutil.Process(child.pid)
        result = read_record(child)
        assert result == {"case": "spawn-failure", "attempts": 66, "passed": True}
        assert read_record(child) == {"event": "backend-exited", "code": 0}
        child.stdin.write(b"host-quit\n")
        child.stdin.flush()
        assert child.wait(timeout=5) == 0
        report.update(passed=True, attempts=66)
    except Exception as error:
        report["failure"] = type(error).__name__
    finally:
        try:
            if identity is not None and live(identity):
                owned = [identity, *identity.children(recursive=True)]
                for index, process in reversed(list(enumerate(owned))):
                    if live(process):
                        process.kill()
                        report["harnessCleanup"].append(index)
                report["passed"] = False
                if not await_gone(owned):
                    report["cleanupFailure"] = True
            if child is not None:
                child.wait(timeout=5)
        except Exception as error:
            report["passed"] = False
            report["cleanupFailure"] = type(error).__name__
    return report


def source_state():
    files = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).split(b"\0")
    fingerprint = hashlib.sha256()
    for name in sorted(filter(None, files)):
        path = ROOT / os.fsdecode(name)
        fingerprint.update(name + b"\0")
        fingerprint.update(
            hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b"missing"
        )
    return {
        "commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        "fingerprint": fingerprint.hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--host", required=True)
    args = parser.parse_args()
    if sys.platform == "win32" and (
        os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or ctypes.windll.shell32.IsUserAnAdmin() != 0
    ):
        parser.error("Windows qualification requires a disposable hosted standard user")
    before = source_state()
    owner_before = hashlib.sha256(Path(args.owner).read_bytes()).hexdigest()
    host_before = hashlib.sha256(Path(args.host).read_bytes()).hexdigest()
    results = [
        run_case(
            args.bun,
            str(Path(args.owner).resolve(strict=True)),
            str(Path(args.host).resolve(strict=True)),
            mode,
        )
        for mode in (
            "natural",
            "close",
            "cancel",
            "exit-backend",
            "kill-backend",
            "host-quit",
            "kill-host",
            "kill-guardian",
        )
    ]
    results.append(
        run_spawn_failure(
            args.bun,
            str(Path(args.owner).resolve(strict=True)),
            str(Path(args.host).resolve(strict=True)),
        )
    )
    after = source_state()
    owner_after = hashlib.sha256(Path(args.owner).read_bytes()).hexdigest()
    host_after = hashlib.sha256(Path(args.host).read_bytes()).hexdigest()
    provenance = (
        before == after
        and not before["dirty"]
        and owner_before == owner_after
        and host_before == host_after
    )
    supported = [row for row in results if "unsupported" not in row]
    boundaries = [row for row in results if "unsupported" in row]
    passed = (
        provenance
        and all(row["passed"] for row in supported)
        and all(
            row.get("boundaryObserved")
            and not row.get("cleanupFailure")
            and not row.get("cleanupFailures")
            and not row.get("unexpectedCleanup")
            for row in boundaries
        )
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "passed": passed,
                "sourceBefore": before,
                "sourceAfter": after,
                "provenancePassed": provenance,
                "platform": sys.platform,
                "machine": platform.machine(),
                "bunVersion": subprocess.check_output([args.bun, "--version"], text=True).strip(),
                "hostSha256Before": host_before,
                "hostSha256After": host_after,
                "ownerSha256Before": owner_before,
                "ownerSha256After": owner_after,
                "results": supported,
                "unsupportedObservations": boundaries,
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps(results, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Qualify real Chromium cleanup on private copies of baseline/current macOS apps.

Every attempt is retained. A missed sampling opportunity is explicitly unobserved;
an actual process, provenance, timeout or clone-removal failure cannot be retried
into a passing result. No source bundle or global clone directory is modified.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("clone_observer", ROOT / "scripts/observe-process.py")
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


def native_smoke_complete(report):
    records = []
    for line in [*report["stdoutTail"], *report["stderr"]]:
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                records.append(value)
        except ValueError:
            pass
    smokes = [row for row in records if row.get("event") == "bunly.native.smoke"]
    if len(smokes) != 1:
        return False
    smoke = smokes[0]
    diagnostics = smoke.get("diagnostics", {})
    return (
        smoke.get("passed") is True
        and smoke.get("cycles") == 20
        and isinstance(diagnostics, dict)
        and all(diagnostics.get(key) == 1 for key in ("windows", "views", "sessions"))
        and any(
            row.get("event") == "bunly.backend.exit"
            and row.get("code") == 0
            and row.get("forced") is False
            for row in records
        )
        and any(
            row.get("event") == "bunly.host.shutdown" and row.get("clean") is True
            for row in records
        )
        and not any(row.get("event") == "bunly.host.failure" for row in records)
    )


class SlowCleanup:
    """Pause only an independently verified helper; always attempt bounded resume."""

    def __init__(self):
        self.identity = None
        self.tracker = None
        self.thread = None
        self.stop = threading.Event()
        self.failure = None
        self.resumed_after_root_exit_ms = None
        self.stopped_observed = False

    def __call__(self, tracker):
        self.tracker = tracker
        if self.identity is not None or self.failure is not None:
            return
        # The callback must not raise into the observer while an owned process
        # is suspended. Its failure is retained as a failed qualification.
        try:
            for identity in tracker.helpers:
                if not tracker.grant(identity) or tracker.state(identity) != "running":
                    continue
                process = observer.owned_process(identity)
                if process is None:
                    continue
                self.identity, self.tracker = identity, tracker
                process.suspend()
                self.stopped_observed = (
                    psutil.Process(identity[0]).status() == psutil.STATUS_STOPPED
                )
                self.thread = threading.Thread(target=self.resume_after_exit, daemon=True)
                self.thread.start()
                break
        except Exception:
            self.failure = "identity-bound-suspension-failed"
            self.resume()

    def resume(self):
        try:
            if (
                self.identity is not None
                and self.tracker is not None
                and self.tracker.state(self.identity) == "running"
            ):
                process = observer.owned_process(self.identity)
                if process is not None:
                    process.resume()
        except (psutil.Error, OSError, ValueError):
            self.failure = "identity-bound-resume-failed"

    def resume_after_exit(self):
        try:
            root_identity = (self.tracker.root_pid, self.tracker.root_birth)
            deadline = time.monotonic() + 35
            while observer.owned_process(root_identity) is not None:
                if self.stop.wait(0.01) or time.monotonic() >= deadline:
                    self.failure = "root-exit-not-observed-before-resume"
                    return
            root_exit = time.monotonic()
            if self.stop.wait(0.75):
                self.failure = "slow-cleanup-interrupted"
                return
            if self.tracker.state(self.identity) != "running":
                self.failure = "suspended-helper-identity-lost"
                return
            self.resume()
            self.resumed_after_root_exit_ms = (time.monotonic() - root_exit) * 1000
        except (psutil.Error, OSError, ValueError, TypeError):
            self.failure = "slow-cleanup-observation-failed"
        finally:
            self.resume()

    def close(self):
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=1)
            if self.thread.is_alive():
                self.failure = "resume-thread-did-not-settle"
        self.resume()

    def report(self):
        return {
            "injected": self.identity is not None,
            "stoppedObserved": self.stopped_observed,
            "resumedAfterRootExitMs": self.resumed_after_root_exit_ms,
            "failure": self.failure,
            "method": "identity-checked-SIGSTOP-and-SIGCONT; 750ms after observed root exit",
        }


def fingerprint(app):
    result = {}
    for relative in (
        "Contents/MacOS/bunly_host",
        "Contents/Frameworks/bunly_host Helper.app/Contents/MacOS/bunly_host Helper",
        "Contents/Info.plist",
        "Contents/Resources/runtime.json",
        "Contents/Resources/backend/application.js",
    ):
        path = app / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError("source-fingerprint-file-missing-or-linked")
        with path.open("rb") as source:
            digest = hashlib.sha256()
            while chunk := source.read(65536):
                digest.update(chunk)
            result[relative] = digest.hexdigest()
    return result


def run_trial(app, work, label, mode, index, stop_event):
    name = f"{label}-{mode}-{index}"
    original_cache = os.environ.get("BUNLY_CACHE_DIR")
    os.environ["BUNLY_CACHE_DIR"] = str(work / (name + "-profile"))
    slow = SlowCleanup() if mode == "slow" else None
    try:
        report = observer.observe(
            [str(app / "Contents/MacOS/bunly_host")],
            timeout=35,
            interval=0.01,
            cleanup_observer=slow,
            stop_event=stop_event,
        )
    finally:
        if slow is not None:
            slow.close()
        if original_cache is None:
            os.environ.pop("BUNLY_CACHE_DIR", None)
        else:
            os.environ["BUNLY_CACHE_DIR"] = original_cache
    with (work / (name + ".json")).open("x", encoding="utf8") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    cleanup = report.get("postExitCleanup")
    clean = (
        report["exitCode"] == 0
        and not any(
            report[key]
            for key in (
                "timedOut",
                "cancelled",
                "outputOverflow",
                "observedOrphans",
                "cleanupSurvivors",
            )
        )
        and native_smoke_complete(report)
        and cleanup is not None
        and cleanup["passed"]
    )
    delay = slow.report() if slow is not None else None
    if delay is not None and delay["failure"] is not None:
        clean = False
    qualified = clean and cleanup["qualified"] and cleanup["observedClones"] > 0
    if mode == "slow":
        qualified = (
            qualified
            and delay["stoppedObserved"]
            and delay["resumedAfterRootExitMs"] is not None
            and delay["resumedAfterRootExitMs"] >= 750
            and cleanup["resources"]["sampleCount"] > 0
        )
    return {
        "label": label,
        "mode": mode,
        "attempt": index,
        "report": name + ".json",
        "outcome": "qualified" if qualified else "not-observed" if clean else "failed",
        "cleanup": cleanup,
        "slowCleanup": delay,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--attempts", type=int, default=3)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Native macOS execution is required; there is no simulated passing mode")
    if not 1 <= args.attempts <= 5:
        parser.error("Attempts must be between one and five")
    if args.output.exists() or args.output.is_symlink():
        parser.error("Refusing to overwrite prior qualification evidence")
    sources = {"baseline": args.baseline, "current": args.current}
    for path in sources.values():
        if path.is_symlink() or not path.is_dir() or path.suffix != ".app":
            parser.error("Both inputs must be prepared native macOS app directories")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="clone-cleanup-", dir=args.output.parent)).resolve()
    report = {
        "schema": 1,
        "profile": "macos-baseline-current-code-sign-cleanup",
        "passed": False,
        "sources": {},
        "trials": [],
        "workDirectory": work.name,
        "limitations": [
            "Polling can miss a short-lived helper; unobserved attempts are retained and do not qualify",
            "Slow cleanup uses a verified helper suspension, not an artificial runtime timeout change",
            "CPU/resource measurements are sampled lower-bound diagnostics, not complete lifetime accounting",
            "No helper exit-code attestation, production-signing claim, or renderer-authority qualification",
        ],
    }
    stop_event = threading.Event()
    signal.signal(signal.SIGTERM, lambda _number, _frame: stop_event.set())
    signal.signal(signal.SIGINT, lambda _number, _frame: stop_event.set())
    try:
        for label, source in sources.items():
            source = source.resolve(strict=True)
            before = fingerprint(source)
            app = work / (label + ".app")
            # APFS clone copies preserve the frozen source and avoid a multi-GB
            # full copy for each sampling attempt. No hard links to source files.
            subprocess.run(["/bin/cp", "-cR", str(source), str(app)], check=True, timeout=120)
            if (app / "Contents/MacOS/bunly_host").stat().st_ino == (
                source / "Contents/MacOS/bunly_host"
            ).stat().st_ino:
                raise ValueError("private-copy-must-not-hardlink-source")
            report["sources"][label] = {"fingerprint": before}
            for mode in ("prompt", "slow"):
                for index in range(1, args.attempts + 1):
                    trial = run_trial(app, work, label, mode, index, stop_event)
                    report["trials"].append(trial)
                    print(
                        json.dumps(
                            {
                                "label": label,
                                "mode": mode,
                                "attempt": index,
                                "outcome": trial["outcome"],
                            }
                        ),
                        flush=True,
                    )
                    if trial["outcome"] == "failed":
                        raise ValueError("actual-cleanup-failure-retained")
                    if trial["outcome"] == "qualified":
                        break
                else:
                    raise ValueError("cleanup-identity-not-observed-within-attempt-budget")
            unchanged = fingerprint(source) == before
            report["sources"][label]["fingerprintedSourceFilesUnchanged"] = unchanged
            if not unchanged:
                raise ValueError("input-source-fingerprint-changed")
        report["passed"] = True
    except (OSError, ValueError, subprocess.SubprocessError, psutil.Error) as error:
        report["failure"] = str(error) if isinstance(error, ValueError) else type(error).__name__
    finally:
        with args.output.open("x", encoding="utf8") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
    # Retain private copies and every report for review. In particular, a failed
    # cleanup is not permission to delete an unproven clone directory.
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "trials": len(report["trials"]),
                "failure": report.get("failure"),
            }
        )
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

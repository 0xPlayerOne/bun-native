"""Headless command-tail joins; these controls execute no native host or GUI."""

import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from scripts.quality.native_harness import cli_standalone
from scripts.quality.native_harness import native_watch_processes as PROCESS

ROOT = Path(__file__).resolve().parents[2]

PARENT = """
import pathlib, subprocess, sys
child = subprocess.Popen([sys.executable, '-S', '-c', sys.argv[2], sys.argv[1]])
pathlib.Path(sys.argv[1], 'child-pid').write_text(str(child.pid))
sys.stdin.buffer.read(1)
"""
CHILD = """
import pathlib, sys, time
root = pathlib.Path(sys.argv[1])
end = time.monotonic() + 8
(root / 'child-ready').write_text('initialized')
while not (root / 'release-child').exists():
    if time.monotonic() >= end:
        raise RuntimeError('test child was not released')
    time.sleep(0.01)
(root / 'child-finished').write_text('normal exit')
print('child pipe complete', flush=True)
"""


def row(pid, parent, started, state="S"):
    return {
        "pid": pid,
        "parent_pid": parent,
        "process_group": 100,
        "start_ticks": started,
        "state": state,
        "rss_bytes": 0,
    }


class CommandJoinIdentityTests(unittest.TestCase):
    def audit(self):
        audit = PROCESS.ProcessAudit.__new__(PROCESS.ProcessAudit)
        audit.app = Mock(pid=100)
        audit.app.poll.return_value = 0
        audit.ownership = PROCESS.Ownership(row(100, 1, 10))
        audit.observed = audit.ownership.observed
        audit.observed[101] = 11
        audit.lock = threading.Lock()
        audit.error = None
        return audit

    def test_reused_and_unobserved_pids_are_never_reaped_or_newly_discovered(self):
        audit = self.audit()
        table = {
            100: row(100, 1, 99),
            101: row(101, os.getpid(), 100, "Z"),
            102: row(102, os.getpid(), 12, "Z"),
        }
        with (
            patch.object(PROCESS.DRIVER, "process_table", return_value=table),
            patch.object(PROCESS.os, "waitpid") as reap,
        ):
            audit.wait_for_exit(time.monotonic() + 1)
            reap.assert_not_called()
        self.assertFalse(audit.ownership.discovering)
        self.assertEqual(audit.snapshot(), {100: 10, 101: 11})

    def test_only_an_identity_matched_adopted_zombie_can_be_reaped(self):
        audit = self.audit()
        zombie = {101: row(101, os.getpid(), 11, "Z")}
        with (
            patch.object(PROCESS.DRIVER, "process_table", side_effect=[zombie, {}]),
            patch.object(PROCESS.os, "waitpid", return_value=(101, 0)) as reap,
        ):
            audit.wait_for_exit(time.monotonic() + 1)
        reap.assert_called_once_with(101, os.WNOHANG)

    def test_live_direct_child_expired_budget_and_audit_error_remain_failures(self):
        audit = self.audit()
        audit.app.poll.return_value = None
        with self.assertRaisesRegex(RuntimeError, "direct command"):
            audit.wait_for_exit(time.monotonic() + 1)
        audit.app.poll.return_value = 0
        with self.assertRaisesRegex(TimeoutError, "command bound"):
            audit.wait_for_exit(time.monotonic() - 1)
        audit.error = "retained audit failure"
        with self.assertRaisesRegex(RuntimeError, "retained audit failure"):
            audit.wait_for_exit(time.monotonic() + 1)


@unittest.skipUnless(
    sys.platform == "linux", "Linux /proc identity and subreaper control"
)
class CommandJoinProcessTests(unittest.TestCase):
    def exercise(self, release):
        PROCESS.DRIVER.enable_subreaper()
        with tempfile.TemporaryDirectory(prefix="bun-native-join-") as directory:
            root = Path(directory)
            app = subprocess.Popen(
                [sys.executable, "-c", PARENT, str(root), CHILD],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            audit = None
            captures = []
            timer = None
            try:
                audit = PROCESS.ProcessAudit(app, root / "not-a-host", sys.executable)
                captures = [
                    PROCESS.Capture(stream, root / name, record_limit=0)
                    for stream, name in ((app.stdout, "out"), (app.stderr, "err"))
                ]
                until = time.monotonic() + 3
                while True:
                    audit.check()
                    marker = root / "child-pid"
                    value = marker.read_text() if marker.exists() else ""
                    if value.isdigit() and int(value) in audit.snapshot():
                        break
                    self.assertLess(time.monotonic(), until, "Child was not observed")
                    time.sleep(0.01)
                child = int(value)
                app.stdin.write(b"!")
                app.stdin.close()
                self.assertEqual(app.wait(timeout=1), 0)
                self.assertIn(child, audit.snapshot())
                self.assertFalse((root / "child-finished").exists())
                if release:
                    timer = threading.Timer(
                        0.1, lambda: (root / "release-child").write_text("finish")
                    )
                    timer.start()
                    deadline = time.monotonic() + 2
                    audit.wait_for_exit(deadline)
                    self.assertEqual(
                        (root / "child-finished").read_text(), "normal exit"
                    )
                    for capture in captures:
                        capture.thread.join(max(0, deadline - time.monotonic()))
                        self.assertFalse(capture.thread.is_alive())
                        self.assertIsNone(capture.error)
                    self.assertEqual(
                        (root / "out").read_text(), "child pipe complete\n"
                    )
                    self.assertNotIn(child, PROCESS.DRIVER.process_table())
                else:
                    with self.assertRaisesRegex(TimeoutError, "command bound"):
                        audit.wait_for_exit(time.monotonic() + 0.15)
                audit.finished.set()
                audit.thread.join(timeout=1)
                self.assertFalse(audit.thread.is_alive())
                result = PROCESS.DRIVER.cleanup(app, audit.snapshot())
                self.assertEqual(result["forced_termination"], not release)
                self.assertEqual(result["remaining_observed_pids"], [])
                self.assertEqual(result["unreaped_observed_pids"], [])
            finally:
                if timer:
                    timer.cancel()
                    timer.join()
                if audit:
                    audit.finished.set()
                    audit.thread.join(timeout=1)
                    PROCESS.DRIVER.cleanup(app, audit.snapshot())
                else:
                    PROCESS.join_unobserved_child(app)
                for capture in captures:
                    capture.thread.join(timeout=1)
                for stream in (app.stdin, app.stdout, app.stderr):
                    if not stream.closed:
                        stream.close()

    def test_observed_child_finishes_and_inherited_pipes_close_without_signals(self):
        self.exercise(release=True)

    def test_non_exiting_child_is_still_rejected_and_requires_forced_cleanup(self):
        self.exercise(release=False)


@unittest.skipUnless(
    sys.platform == "linux", "Linux /proc identity and subreaper control"
)
class StandaloneSupervisorTests(unittest.TestCase):
    def exercise(self, release):
        controller = cli_standalone
        controller.DRIVER.enable_subreaper()
        with tempfile.TemporaryDirectory(prefix="bun-native-supervisor-") as directory:
            root = Path(directory)
            (root / "logs").mkdir()
            report = {
                "commands": [],
                "host": {"path": str(root / "not-a-host")},
                "bun": {"path": sys.executable},
            }
            audits = []
            errors = []
            constructor = controller.PROCESS.ProcessAudit

            def record_audit(*args):
                audit = constructor(*args)
                audits.append(audit)
                return audit

            def release_parent():
                end = time.monotonic() + 5
                while time.monotonic() < end:
                    marker = root / "child-pid"
                    value = marker.read_text() if marker.exists() else ""
                    if (
                        audits
                        and value.isdigit()
                        and int(value) in audits[0].snapshot()
                        and (root / "child-ready").exists()
                    ):
                        (root / "exit-parent").write_text("observed")
                        if release:
                            while (
                                audits[0].app.returncode is None
                                and time.monotonic() < end
                            ):
                                time.sleep(0.005)
                            time.sleep(0.1)
                            (root / "release-child").write_text("finish")
                        return
                    time.sleep(0.005)
                errors.append("Initialized child was not observed")

            # The direct wrapper exits first only after the child is initialized
            # and the real audit owns its identity. The child inherits both pipes.
            parent = PARENT.replace(
                "sys.stdin.buffer.read(1)",
                """import time
end = time.monotonic() + 5
while not pathlib.Path(sys.argv[1], 'exit-parent').exists():
    if time.monotonic() >= end:
        raise RuntimeError('test parent was not released')
    time.sleep(0.005)""",
            )
            observer = threading.Thread(target=release_parent)
            observer.start()
            try:
                with patch.object(
                    controller.PROCESS, "ProcessAudit", side_effect=record_audit
                ):
                    arguments = (
                        report,
                        root,
                        "command-tail",
                        [sys.executable, "-S", "-c", parent, str(root), CHILD],
                        root,
                        os.environ.copy(),
                        3,
                        time.monotonic() + 12,
                    )
                    if release:
                        controller.run_owned(*arguments)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "command bound"):
                            controller.run_owned(*arguments)
            finally:
                observer.join(timeout=6)
            self.assertFalse(observer.is_alive())
            self.assertEqual(errors, [])
            record = report["commands"][0]
            self.assertEqual(record["status"], "passed" if release else "failed")
            self.assertEqual(record.get("natural_exit_joined", False), release)
            self.assertEqual(record["cleanup"]["forced_termination"], not release)
            self.assertEqual(record["cleanup"]["application_exit_code"], 0)
            self.assertEqual(record["cleanup"]["remaining_observed_pids"], [])
            self.assertEqual(record["cleanup"]["unreaped_observed_pids"], [])
            self.assertTrue(record["log_readers_joined"])
            self.assertTrue(record["process_audit_joined"])
            self.assertEqual((root / "child-finished").exists(), release)

    def test_complete_supervisor_joins_observed_descendants_before_cleanup(self):
        self.exercise(release=True)

    def test_complete_supervisor_keeps_timeout_and_forced_cleanup_as_failure(self):
        self.exercise(release=False)


if __name__ == "__main__":
    unittest.main()

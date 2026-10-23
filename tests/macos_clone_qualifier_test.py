"""The native qualifier's fault controls must preserve ownership even on failure."""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location(
    "clone_qualifier", SCRIPTS / "qualify-macos-clone-cleanup.py"
)
qualifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualifier)


class SlowCleanupTests(unittest.TestCase):
    def test_live_root_never_allows_suspension(self):
        slow = qualifier.SlowCleanup()
        tracker = Mock()
        tracker.helpers = {(123, 1.0): "abc123"}
        with patch.object(qualifier.observer, "owned_process") as owned:
            slow(tracker)
        tracker.grant.assert_not_called()
        owned.assert_not_called()
        self.assertFalse(slow.report()["injected"])

    def test_post_exit_marker_does_not_allow_stop_before_reparenting(self):
        slow = qualifier.SlowCleanup()
        slow.on_root_exit(10.0)
        tracker = Mock()
        tracker.helpers = {(123, 1.0): "abc123"}
        tracker.grant.return_value = True
        tracker.state.return_value = "running"
        process = Mock()
        process.ppid.return_value = 100
        with patch.object(qualifier.observer, "owned_process", return_value=process):
            slow(tracker)
        process.suspend.assert_not_called()
        self.assertFalse(slow.report()["injected"])

    def test_post_exit_suspension_holds_full_interval_before_verified_resume(self):
        slow = qualifier.SlowCleanup()
        slow.on_root_exit(10.0)
        tracker = Mock()
        tracker.helpers = {(123, 1.0): "abc123"}
        tracker.grant.return_value = True
        tracker.state.return_value = "running"
        process = Mock()
        process.ppid.return_value = 1
        process.status.return_value = qualifier.psutil.STATUS_STOPPED
        with (
            patch.object(qualifier.observer, "owned_process", return_value=process),
            patch.object(qualifier.psutil, "Process", return_value=process),
            patch.object(qualifier.time, "monotonic", return_value=10.1),
            patch.object(qualifier.threading, "Thread") as thread,
        ):
            slow(tracker)
        process.suspend.assert_called_once()
        thread.return_value.start.assert_called_once()
        slow.stop = Mock()
        slow.stop.wait.return_value = False
        with (
            patch.object(qualifier.observer, "owned_process", return_value=process),
            patch.object(qualifier.time, "monotonic", return_value=10.85),
        ):
            slow.resume_after_delay()
        slow.stop.wait.assert_called_once_with(0.75)
        self.assertIsNone(slow.failure)
        report = slow.report()
        self.assertTrue(report["suspendedAfterRootExit"])
        self.assertTrue(report["stoppedObserved"])
        self.assertAlmostEqual(report["heldMs"], 750)
        self.assertAlmostEqual(report["resumedAfterRootExitMs"], 850)
        process.resume.assert_called()

    def test_resume_never_targets_a_reused_or_foreign_pid(self):
        slow = qualifier.SlowCleanup()
        slow.identity = (123, 1.0)
        slow.tracker = Mock()
        slow.tracker.state.return_value = "running"
        with patch.object(qualifier.observer, "owned_process", return_value=None) as owned:
            slow.resume()
        owned.assert_called_once_with((123, 1.0))

    def test_changed_helper_provenance_prevents_resume(self):
        slow = qualifier.SlowCleanup()
        slow.identity = (123, 1.0)
        slow.tracker = Mock()
        slow.tracker.state.return_value = "invalid"
        with patch.object(qualifier.observer, "owned_process") as owned:
            slow.close()
        owned.assert_not_called()

    def test_suspension_failure_is_retained_without_escaping_observer(self):
        slow = qualifier.SlowCleanup()
        slow.on_root_exit(10.0)
        tracker = Mock()
        tracker.helpers = {(123, 1.0): "abc123"}
        tracker.grant.return_value = True
        tracker.state.return_value = "running"
        process = Mock()
        process.ppid.return_value = 1
        process.suspend.side_effect = qualifier.psutil.AccessDenied(123)
        with patch.object(qualifier.observer, "owned_process", return_value=process):
            slow(tracker)
            slow.close()
        self.assertEqual(slow.report()["failure"], "identity-bound-suspension-failed")
        process.resume.assert_called()

    def test_successful_exit_without_native_smoke_is_not_qualification(self):
        self.assertFalse(qualifier.native_smoke_complete({"stdoutTail": [], "stderr": []}))


if __name__ == "__main__":
    unittest.main()

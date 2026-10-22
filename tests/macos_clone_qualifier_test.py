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
        tracker = Mock()
        tracker.helpers = {(123, 1.0): "abc123"}
        tracker.grant.return_value = True
        tracker.state.return_value = "running"
        process = Mock()
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

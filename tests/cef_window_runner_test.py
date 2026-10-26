"""Runner readiness/cleanup tests; these do not qualify Linux window modes."""

import importlib.util
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "window_runner",
    Path(__file__).resolve().parents[1] / "scripts/qualify-cef-window-modes-linux.py",
)
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


@unittest.skipIf(sys.platform == "win32", "POSIX runner ownership only")
class WindowRunnerTests(unittest.TestCase):
    def test_readiness_is_an_actual_receipt_not_a_delay(self):
        reader, writer = os.pipe()
        try:
            os.write(writer, b"ready")
            self.assertEqual(subject.ready(reader, b"ready"), b"ready")
            os.write(writer, b"wrong")
            with self.assertRaisesRegex(RuntimeError, "Invalid"):
                subject.ready(reader, b"ready")
            with (
                patch.object(subject.select, "select", return_value=([], [], [])),
                self.assertRaisesRegex(RuntimeError, "deadline"),
            ):
                subject.ready(reader)
        finally:
            os.close(reader)
            os.close(writer)

    def test_only_the_owned_process_group_is_stopped(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import signal; signal.pause()"], start_new_session=True
        )
        try:
            subject.stop(child)
            self.assertIsNotNone(child.poll())
            with self.assertRaises(ProcessLookupError):
                os.killpg(child.pid, 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)

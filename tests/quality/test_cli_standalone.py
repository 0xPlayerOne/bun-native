"""Inert ownership/file controls; never install, compile or launch a consumer."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.quality.native_harness import cli_standalone as SCENARIO

ROOT = Path(__file__).resolve().parents[2]


class StandaloneOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "evidence"
        self.owned = self.output / "owned"
        self.owned.mkdir(parents=True)
        (self.owned / "consumer.txt").write_text("owned fixture")
        (self.output / "retained.log").write_text("preserved evidence")
        self.marker = {"directory": str(self.owned), "token": "fixture-owner"}
        (self.owned / "ownership.json").write_text(json.dumps(self.marker))
        self.command = {
            "status": "passed",
            "spawned": True,
            "process_audit_established": True,
            "process_audit_joined": True,
            "log_readers_joined": True,
            "cleanup": {
                "application_exit_code": 0,
                "remaining_observed_pids": [],
                "unreaped_observed_pids": [],
            },
        }
        self.report = {
            "status": "prepared",
            "ownership": self.marker,
            "commands": [self.command],
        }

    def test_cleanup_requires_original_marker_and_complete_joined_receipts(self):
        for field in (
            "process_audit_established",
            "process_audit_joined",
            "log_readers_joined",
        ):
            self.command[field] = False
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(RuntimeError, "unverified"),
            ):
                SCENARIO.remove_owned(self.output, self.report)
            self.assertTrue((self.owned / "consumer.txt").exists())
            self.command[field] = True
        for field, value in [
            ("application_exit_code", None),
            ("remaining_observed_pids", [123]),
            ("unreaped_observed_pids", [123]),
        ]:
            original = self.command["cleanup"][field]
            self.command["cleanup"][field] = value
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(RuntimeError, "unverified"),
            ):
                SCENARIO.remove_owned(self.output, self.report)
            self.command["cleanup"][field] = original
        (self.owned / "ownership.json").write_text(
            json.dumps({**self.marker, "token": "foreign"})
        )
        with self.assertRaisesRegex(RuntimeError, "original exclusive ownership"):
            SCENARIO.remove_owned(self.output, self.report)
        self.assertTrue((self.owned / "consumer.txt").exists())

        (self.owned / "ownership.json").write_text(json.dumps(self.marker))
        SCENARIO.remove_owned(self.output, self.report)
        self.assertTrue(self.report["owned_directory_removed"])
        self.assertFalse(self.owned.exists())
        self.assertEqual(
            (self.output / "retained.log").read_text(), "preserved evidence"
        )

    def test_foreign_root_link_is_never_removed(self):
        foreign = self.output / "foreign"
        self.owned.rename(foreign)
        self.owned.symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "replaced"):
            SCENARIO.remove_owned(self.output, self.report)
        self.assertTrue((foreign / "consumer.txt").exists())

    def test_terminal_failure_and_interrupted_state_cannot_turn_into_success(self):
        # Invariance is separately checked against real source and file digests.
        # This filesystem control isolates finalization's existing outcome/owner.
        for status in ("failed", "running", "preparing", "prepared"):
            with self.subTest(status=status), patch.object(SCENARIO, "invariant"):
                report = {**self.report, "status": status}
                if status == "failed":
                    report["error"] = "original command failure"
                (self.output / "result.json").write_text(json.dumps(report))
                result = SCENARIO.finalize(SimpleNamespace(output=self.output))
                self.assertEqual(result["status"], "failed")
                self.assertTrue(result["owned_directory_removed"])
                if status == "failed":
                    self.assertEqual(result["error"], "original command failure")

    def test_exhausted_budget_cannot_spawn_a_partial_command(self):
        with patch.object(SCENARIO.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "complete command bound"):
                SCENARIO.run_owned(
                    self.report,
                    self.output,
                    "not-started",
                    ["never-run"],
                    self.output,
                    {},
                    45,
                    time.monotonic() + 45,
                )
            spawn.assert_not_called()
        self.assertEqual(len(self.report["commands"]), 1)
        self.assertTrue((self.owned / "consumer.txt").exists())

    def test_persisted_running_no_spawn_record_cannot_authorize_cleanup(self):
        # This is the last durable record before Popen. If its owner disappears,
        # the next cleanup process cannot know whether a child was created.
        self.report["commands"] = [{"status": "running", "spawned": False}]
        (self.output / "result.json").write_text(json.dumps(self.report))
        with patch.object(SCENARIO, "invariant"):
            result = SCENARIO.finalize(SimpleNamespace(output=self.output))
        self.assertEqual(result["status"], "failed")
        self.assertTrue((self.owned / "consumer.txt").exists())
        self.assertIn("unverified", result["secondary_errors"][0])

        # A completed failure that explicitly recorded no child is safe to join.
        result["commands"][0]["status"] = "failed"
        SCENARIO.remove_owned(self.output, result)
        self.assertTrue(result["owned_directory_removed"])
        self.assertFalse(self.owned.exists())


@unittest.skipUnless(sys.platform == "linux", "The hosted owner uses Linux pass_fds")
class OwnedStartTests(unittest.TestCase):
    def test_exec_preserves_the_anchored_pid_and_exact_inert_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "executed.json"
            read, write = os.pipe()
            command = [
                sys.executable,
                "-c",
                "import json,os,sys; open(sys.argv[1],'w').write(json.dumps({'pid':os.getpid(),'args':sys.argv[2:]}))",
                str(marker),
                "space value",
                "literal-$()`",
            ]
            child = subprocess.Popen(
                [
                    sys.executable,
                    ROOT / "tests/native/cli-owned-exec.py",
                    str(read),
                    *command,
                ],
                pass_fds=(read,),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            os.close(read)
            try:
                self.assertFalse(marker.exists())
                os.write(write, b"!")
                os.close(write)
                write = None
                _, stderr = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, stderr)
                self.assertEqual(
                    json.loads(marker.read_text()),
                    {"pid": child.pid, "args": command[-2:]},
                )
            finally:
                if write is not None:
                    os.close(write)
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=2)
                child.stderr.close()

    def test_eof_or_wrong_start_byte_never_executes_the_inert_command(self):
        with tempfile.TemporaryDirectory() as directory:
            for byte in (b"", b"?"):
                marker = Path(directory) / ("eof" if not byte else "wrong-byte")
                read, write = os.pipe()
                child = subprocess.Popen(
                    [
                        sys.executable,
                        ROOT / "tests/native/cli-owned-exec.py",
                        str(read),
                        sys.executable,
                        "-c",
                        "import sys; open(sys.argv[1],'w').write('unexpected')",
                        str(marker),
                    ],
                    pass_fds=(read,),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                os.close(read)
                if byte:
                    os.write(write, byte)
                os.close(write)
                try:
                    _, stderr = child.communicate(timeout=5)
                    self.assertNotEqual(child.returncode, 0)
                    self.assertIn(b"start handshake was not released", stderr)
                    self.assertFalse(marker.exists())
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=2)
                    child.stderr.close()


if __name__ == "__main__":
    unittest.main()

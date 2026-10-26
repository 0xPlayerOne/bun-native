"""Fail-closed ownership gates for non-suspending shutdown thread reads."""

import ctypes
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from capture_cef_shutdown import (
    Capture,
    decode_thread_info,
    finish_capture,
    read_threads,
    root_executable_matches,
    verified_target,
)
from macos_process_identity import KernelIdentity


class ShutdownCaptureTests(unittest.TestCase):
    def setUp(self):
        # Simulated macOS identities must also run on Windows portable CI.
        uid = patch("capture_cef_shutdown.os.getuid", return_value=501, create=True)
        uid.start()
        self.addCleanup(uid.stop)
        self.app = Path("/private/fixture/Terminal.app")
        self.root_id = KernelIdentity(11, 9, 1, b"a" * 16)
        self.child_id = KernelIdentity(12, 11, 1, b"b" * 16)
        self.root = Mock()
        self.root.pid = 10
        self.root.create_time.return_value = 3.0
        self.root.exe.return_value = str(self.app / "Contents/MacOS/bunly_host")
        self.root.uids.return_value = SimpleNamespace(real=os.getuid())
        self.child = Mock()
        self.child.pid = 20
        self.child.ppid.return_value = 10
        self.child.create_time.return_value = 4.0
        self.child.exe.return_value = str(
            self.app / "Contents/Frameworks/bunly_host Helper.app/Contents/MacOS/bunly_host Helper"
        )
        self.child.uids.return_value = SimpleNamespace(real=os.getuid())
        self.child.cmdline.return_value = ["--utility-sub-type=network.mojom.NetworkService"]
        self.root.children.return_value = [self.child]
        self.kernel = Mock()
        self.kernel.identity.side_effect = lambda pid: self.root_id if pid == 10 else self.child_id
        self.tracker = SimpleNamespace(
            invalid=False,
            root_pid=10,
            root_birth=3.0,
            root_kernel=self.root_id,
            kernel=self.kernel,
            main_identity=(1, 2),
            main_hash="hash",
            helper=Path(self.child.exe.return_value),
            helper_stamp=(1, 2, 3, 4, 5),
            helper_hash="hash",
        )

    def target(self, role="network"):
        with (
            patch("capture_cef_shutdown.psutil.Process", return_value=self.root),
            patch("capture_cef_shutdown.executable_digest", return_value=((1, 2, 3, 4, 5), "hash")),
        ):
            return verified_target(self.tracker, self.app, role)

    def test_requires_current_and_original_parent_and_exact_private_executable(self):
        self.assertEqual(self.target()[0], 20)
        for mismatch in ("current-parent", "original-parent", "executable", "uid", "role"):
            with self.subTest(mismatch=mismatch):
                self.setUp()
                if mismatch == "current-parent":
                    self.child.ppid.return_value = 99
                elif mismatch == "original-parent":
                    self.child_id = KernelIdentity(12, 99, 1, b"b" * 16)
                elif mismatch == "executable":
                    self.child.exe.return_value = (
                        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                    )
                elif mismatch == "uid":
                    self.child.uids.return_value = SimpleNamespace(real=os.getuid() + 1)
                else:
                    self.child.cmdline.return_value = ["--type=utility"]
                with self.assertRaises(ValueError):
                    self.target()

    def test_rejects_root_reuse_missing_kernel_identity_and_ambiguous_children(self):
        self.root.create_time.return_value = 99
        with self.assertRaises(ValueError):
            self.target()
        self.setUp()
        self.tracker.root_kernel = None
        with self.assertRaises(ValueError):
            self.target()
        self.setUp()
        self.root.children.return_value = [self.child, self.child]
        with self.assertRaises(ValueError):
            self.target()

    def test_identity_change_never_invokes_sampler(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(self.app, Path(directory), "network", 0)
            with (
                patch("capture_cef_shutdown.verified_target", side_effect=[("old",), ("new",)]),
                patch("capture_cef_shutdown.read_threads") as sample,
            ):
                capture.run(self.tracker)
                sample.assert_not_called()
            self.assertIn("target-replaced-before-capture", capture.records[0]["failure"])

    def test_signing_clone_requires_same_owned_inode_and_hash(self):
        tracker = SimpleNamespace(main_identity=(1, 2), main_hash="expected")
        actual, expected = Path("clone"), Path("private-host")
        for stamp, digest, accepted in [
            ((1, 2, 3, 4, 5), "expected", True),
            ((1, 99, 3, 4, 5), "expected", False),
            ((1, 2, 3, 4, 5), "replacement", False),
        ]:
            with patch("capture_cef_shutdown.executable_digest", return_value=(stamp, digest)):
                self.assertEqual(root_executable_matches(tracker, actual, expected), accepted)

    def test_thread_info_decoder_rejects_short_and_unknown_state(self):
        data = struct.pack("=QQ8i64s", 10, 20, 0, 0, 3, 0, 1, 0, 0, 0, b"ThreadPool")
        self.assertEqual(decode_thread_info(data)["runState"], 3)
        self.assertEqual(decode_thread_info(data)["name"], "ThreadPool")
        with self.assertRaises(ValueError):
            decode_thread_info(data[:-1])
        with self.assertRaises(ValueError):
            decode_thread_info(struct.pack("=QQ8i64s", 0, 0, 0, 0, 99, 0, 0, 0, 0, 0, b""))

    def test_exit_during_read_never_qualifies_the_snapshot(self):
        target = (20, 4.0, self.child_id, Path("helper"), (1, 2, 3, 4, 5), "hash")
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(self.app, Path(directory), "network", 0)
            with (
                patch(
                    "capture_cef_shutdown.verified_target",
                    side_effect=[target, target, ValueError("exited")],
                ),
                patch("capture_cef_shutdown.read_threads", return_value=[{"runState": 3}]),
            ):
                capture.run(self.tracker)
            self.assertNotIn("identityRevalidated", capture.records[0])
            self.assertTrue((Path(directory) / "capture-ledger.json").is_file())
            self.assertIn("exited", capture.records[1]["failure"])

    def test_short_thread_read_is_unavailable_not_zero(self):
        def query(_pid, flavor, _handle, buffer, _size):
            if flavor == 6:
                ctypes.memmove(buffer, struct.pack("=Q", 42), 8)
                return 8
            self.assertEqual(flavor, 5)
            return 0

        with patch("capture_cef_shutdown.ctypes.CDLL") as library:
            library.return_value.proc_pidinfo.side_effect = query
            self.assertEqual(read_threads(10), [{"handle": 42, "unavailable": True}])

    def test_overfull_thread_inventory_is_rejected_before_reading_threads(self):
        with patch("capture_cef_shutdown.ctypes.CDLL") as library:
            query = library.return_value.proc_pidinfo
            query.return_value = 257 * 8
            with self.assertRaises(ValueError):
                read_threads(10)
            query.assert_called_once()

    def test_prelaunch_helper_substitution_cannot_become_a_new_capture_baseline(self):
        for stamp, digest in [((1, 99, 3, 4, 5), "hash"), ((1, 2, 3, 4, 5), "changed")]:
            with self.subTest(stamp=stamp, digest=digest):

                def executable(path, expected=None, stamp=stamp, digest=digest):
                    if path == self.tracker.helper:
                        return stamp, digest
                    return (1, 2, 3, 4, 5), "hash"

                with (
                    patch("capture_cef_shutdown.psutil.Process", return_value=self.root),
                    patch("capture_cef_shutdown.executable_digest", side_effect=executable),
                    self.assertRaisesRegex(ValueError, "helper-changed-since-launch"),
                ):
                    verified_target(self.tracker, self.app, "network")

    def test_missing_tracker_and_unknown_roles_fail_before_process_inspection(self):
        for tracker, role in [(None, "network"), (self.tracker, "other")]:
            with (
                patch("capture_cef_shutdown.psutil.Process") as process,
                self.assertRaises(ValueError),
            ):
                verified_target(tracker, self.app, role)
            process.assert_not_called()

    def test_capture_completion_separates_absent_partial_and_verified_snapshots(self):
        self.assertEqual(finish_capture(None)["status"], "disabled")
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(self.app, Path(directory), "network", 0)
            self.assertEqual(finish_capture(capture)["status"], "not-started")
            capture.worker = Mock()
            capture.worker.is_alive.return_value = False
            capture.records = [{"index": index, "identityRevalidated": True} for index in range(10)]
            self.assertTrue(finish_capture(capture)["captureComplete"])
            capture.records[9].pop("identityRevalidated")
            self.assertEqual(finish_capture(capture)["status"], "incomplete")
            capture.records.append({"failure": "target-exited"})
            self.assertFalse(finish_capture(capture)["captureComplete"])

    def test_unsettled_read_is_cancelled_without_reading_its_mutable_records(self):
        capture = Mock()
        capture.worker.is_alive.return_value = True
        result = finish_capture(capture, timeout=0)
        self.assertEqual(result["status"], "worker-did-not-settle")
        self.assertFalse(result["captureComplete"])
        self.assertEqual(result["records"], [])
        capture.worker.join.assert_called_once_with(timeout=0)
        capture.stop.set.assert_called_once()

    def test_capture_has_one_daemon_worker_and_no_idle_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            capture = Capture(self.app, Path(directory), "network", 10)
            with patch("capture_cef_shutdown.threading.Thread") as thread:
                capture(self.tracker)
                thread.assert_not_called()
                capture.started -= 11
                capture(self.tracker)
                capture(self.tracker)
                thread.assert_called_once_with(
                    target=capture.run, args=(self.tracker,), daemon=True
                )
                thread.return_value.start.assert_called_once()

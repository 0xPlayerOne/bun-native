"""Watch ownership and pipe-capture bounds. No process, GUI or GPU is started."""

import io
import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from scripts.quality.native_harness import native_watch_processes as PROCESS

ROOT = Path(__file__).resolve().parents[2]


def row(pid, parent, started, state="S", rss=0):
    return {
        "pid": pid,
        "parent_pid": parent,
        "process_group": 100,
        "start_ticks": started,
        "state": state,
        "rss_bytes": rss,
    }


class IdentityTests(unittest.TestCase):
    def test_require_identity_accepts_only_the_same_live_start_ticks(self):
        table = {7: row(7, 1, 70)}
        self.assertIs(
            PROCESS.require_identity(table, {"pid": 7, "start_ticks": 70}), table[7]
        )
        for current in ({}, {7: row(7, 1, 71)}, {7: row(7, 1, 70, "Z")}):
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                PROCESS.require_identity(current, {"pid": 7, "start_ticks": 70})

    def test_require_absent_tolerates_recycled_pids_but_not_the_same_identity(self):
        identities = [{"pid": 7, "start_ticks": 70}, {"pid": 8, "start_ticks": 80}]
        PROCESS.require_absent({}, identities)
        PROCESS.require_absent({7: row(7, 1, 99), 8: row(8, 1, 81)}, identities)
        # A zombie with the same identity is unreaped and therefore still present.
        with self.assertRaisesRegex(RuntimeError, "still live or unreaped"):
            PROCESS.require_absent({8: row(8, 1, 80, "Z")}, identities)


class OwnershipTests(unittest.TestCase):
    def test_discovery_records_new_descendants_while_the_root_is_live(self):
        ownership = PROCESS.Ownership({"pid": 100, "start_ticks": 10})
        table = {100: row(100, 1, 10), 102: row(102, 100, 12), 101: row(101, 100, 11)}
        with patch.object(
            PROCESS.DRIVER,
            "owned_processes",
            return_value=[table[102], table[100], table[101]],
        ) as owned:
            rows = ownership.rows(table)
        owned.assert_called_once_with(100, table)
        self.assertEqual([item["pid"] for item in rows], [100, 101, 102])
        self.assertEqual(ownership.observed, {100: 10, 101: 11, 102: 12})
        self.assertTrue(ownership.discovering)

    def test_root_exit_permanently_ends_discovery(self):
        ownership = PROCESS.Ownership({"pid": 100, "start_ticks": 10})
        ownership.observed[101] = 11
        # The root PID was recycled; a new child of the recycled PID must not
        # be discovered, and the stale identity is not followed either.
        table = {
            100: row(100, 1, 99),
            101: row(101, 100, 11),
            103: row(103, 100, 13),
        }
        with patch.object(PROCESS.DRIVER, "owned_processes") as owned:
            rows = ownership.rows(table)
            # The real root reappearing never restarts discovery.
            ownership.rows({100: row(100, 1, 10)})
        owned.assert_not_called()
        self.assertFalse(ownership.discovering)
        self.assertEqual([item["pid"] for item in rows], [101])
        self.assertNotIn(103, ownership.observed)

    def test_reused_pid_rejects_the_whole_snapshot_before_recording_any_row(self):
        ownership = PROCESS.Ownership({"pid": 100, "start_ticks": 10})
        ownership.observed[105] = 15
        table = {100: row(100, 1, 10), 101: row(101, 100, 11), 105: row(105, 100, 16)}
        with (
            patch.object(
                PROCESS.DRIVER, "owned_processes", return_value=list(table.values())
            ),
            self.assertRaisesRegex(RuntimeError, "reused"),
        ):
            ownership.rows(table)
        self.assertEqual(ownership.observed, {100: 10, 105: 15})


class JoinUnobservedChildTests(unittest.TestCase):
    def app(self, waits):
        app = Mock(pid=4321, returncode=None)
        app.wait.side_effect = waits
        return app

    def test_exited_child_joins_without_any_signal(self):
        app = self.app([0])
        app.returncode = 0
        result = PROCESS.join_unobserved_child(app)
        app.terminate.assert_not_called()
        app.kill.assert_not_called()
        app.wait.assert_called_once_with(timeout=0)
        self.assertTrue(result["direct_child_joined"])
        self.assertFalse(result["forced_termination"])
        self.assertFalse(result["descendant_tree_verified"])
        self.assertEqual(result["direct_child_pid"], 4321)
        self.assertEqual(result["application_exit_code"], 0)
        self.assertEqual(result["signal_errors"], [])

    def test_escalates_to_kill_and_retains_signal_errors(self):
        expired = subprocess.TimeoutExpired("app", 0)
        app = self.app([expired, expired, -9])
        app.terminate.side_effect = PermissionError("denied")
        app.kill.side_effect = ProcessLookupError()
        result = PROCESS.join_unobserved_child(app)
        self.assertEqual(
            [call.kwargs["timeout"] for call in app.wait.call_args_list], [0, 2, 1]
        )
        self.assertTrue(result["direct_child_joined"])
        self.assertTrue(result["forced_termination"])
        self.assertEqual(result["signal_errors"], ["denied"])

    def test_unjoinable_child_is_reported_as_not_joined(self):
        expired = subprocess.TimeoutExpired("app", 0)
        result = PROCESS.join_unobserved_child(self.app([expired] * 3))
        self.assertFalse(result["direct_child_joined"])
        self.assertTrue(result["forced_termination"])


class CaptureTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def capture(self, data, name="watch.log", **options):
        options.setdefault("record_limit", 8)
        capture = PROCESS.Capture(io.BytesIO(data), self.root / name, **options)
        capture.thread.join(5)
        self.assertFalse(capture.thread.is_alive())
        return capture

    def test_parses_only_complete_lifecycle_lines(self):
        ready = json.dumps({"pid": 1, "ms": 1.5}).encode()
        capture = self.capture(
            b"noise\nbun-native:ready "
            + ready
            + b"\nbun-native:stopped {}\nbun-native:ready {}",
            parse=True,
        )
        records = capture.snapshot()
        self.assertEqual(
            [(item["kind"], item["value"]) for item in records],
            [("ready", {"pid": 1, "ms": 1.5}), ("stopped", {})],
        )
        self.assertTrue(all(type(item["observed_ns"]) is int for item in records))
        self.assertEqual(capture.written, len((self.root / "watch.log").read_bytes()))

    def test_unparsed_streams_never_record_lifecycle_lines(self):
        capture = self.capture(b"bun-native:ready {}\n")
        self.assertEqual(capture.snapshot(), [])
        self.assertEqual(
            (self.root / "watch.log").read_bytes(), b"bun-native:ready {}\n"
        )

    def test_record_limit_duplicate_fields_and_non_finite_numbers_fail(self):
        cases = {
            b"bun-native:ready {}\nbun-native:ready {}\n": "too many",
            b'bun-native:ready {"a":1,"a":2}\n': "Duplicate",
            b'bun-native:ready {"a":NaN}\n': "Non-finite",
            b'bun-native:ready {"a":1e999}\n': "Non-finite",
        }
        for index, (data, message) in enumerate(cases.items()):
            with self.subTest(message=message):
                capture = self.capture(
                    data, name=f"{index}.log", parse=True, record_limit=1
                )
                with self.assertRaisesRegex(RuntimeError, message):
                    capture.snapshot()

    def test_unterminated_oversized_record_fails(self):
        limit = PROCESS.DRIVER.PAINT_OBSERVER.MAX_RECORD_BYTES
        capture = self.capture(b"x" * (limit + 1), parse=True)
        with self.assertRaisesRegex(RuntimeError, "record exceeded"):
            capture.snapshot()

    def test_log_bound_truncates_the_file_and_fails(self):
        with patch.object(PROCESS.DRIVER, "MAX_LOG_BYTES", 10):
            capture = self.capture(b"0123456789abcdef", parse=True)
        self.assertEqual((self.root / "watch.log").read_bytes(), b"0123456789")
        self.assertEqual((capture.written, capture.discarded), (10, 6))
        with self.assertRaisesRegex(RuntimeError, "4 MiB bound"):
            capture.snapshot()

    def test_existing_log_is_never_overwritten(self):
        (self.root / "watch.log").write_bytes(b"previous")
        capture = self.capture(b"new")
        self.assertEqual((self.root / "watch.log").read_bytes(), b"previous")
        with self.assertRaises(RuntimeError):
            capture.snapshot()


class ProcessImageTests(unittest.TestCase):
    def test_hidden_and_vanished_images_never_look_like_the_host(self):
        with patch.object(PROCESS.Path, "resolve", side_effect=PermissionError):
            self.assertEqual(PROCESS.process_image(7), "")
        with patch.object(PROCESS.Path, "resolve", side_effect=FileNotFoundError):
            self.assertIsNone(PROCESS.process_image(7))
        # A process that exits between the process table and the image read
        # reports ESRCH, not ENOENT.
        gone = ProcessLookupError(3, "No such process")
        with patch.object(PROCESS.Path, "resolve", side_effect=gone):
            self.assertIsNone(PROCESS.process_image(7))
        self.assertTrue(PROCESS.process_image(os.getpid()).startswith("/"))


class ProcessAuditTests(unittest.TestCase):
    def audit(self, discovering=True):
        audit = PROCESS.ProcessAudit.__new__(PROCESS.ProcessAudit)
        audit.app = Mock(pid=100)
        audit.ownership = PROCESS.Ownership({"pid": 100, "start_ticks": 10})
        audit.ownership.discovering = discovering
        audit.observed = audit.ownership.observed
        audit.controllers = None
        audit.error = None
        audit.lock = threading.Lock()
        return audit

    def test_controllers_must_descend_from_the_launched_command(self):
        table = {
            100: row(100, 1, 10),
            110: row(110, 100, 11),
            120: row(120, 110, 12),
            130: row(130, 120, 13),
        }
        audit = self.audit()
        with patch.object(PROCESS.DRIVER, "process_table", return_value=table):
            audit.bind_controllers(130)
        self.assertEqual(audit.controllers, {100, 110, 120})

        table[999] = row(999, 2, 99)
        with (
            patch.object(PROCESS.DRIVER, "process_table", return_value=table),
            self.assertRaisesRegex(RuntimeError, "does not descend"),
        ):
            self.audit().bind_controllers(999)
        with (
            patch.object(
                PROCESS.DRIVER, "process_table", return_value={100: row(100, 1, 11)}
            ),
            self.assertRaisesRegex(RuntimeError, "identity changed"),
        ):
            self.audit().bind_controllers(100)

    def test_resource_snapshot_assigns_roles_and_sums_owned_rss(self):
        table = {
            100: row(100, 1, 10, rss=1),
            110: row(110, 100, 11, rss=2),
            120: row(120, 110, 12, rss=4),
            130: row(130, 120, 13, rss=8),
            140: row(140, 100, 14, rss=16),
        }
        audit = self.audit()
        audit.controllers = {100, 110}
        with (
            patch.object(PROCESS.DRIVER, "process_table", return_value=table),
            patch.object(
                PROCESS.DRIVER, "owned_processes", return_value=list(table.values())
            ),
        ):
            result = audit.resource_snapshot(
                {"pid": 120, "start_ticks": 12}, {"pid": 130, "start_ticks": 13}
            )
        self.assertEqual(result["tree_rss_bytes"], 31)
        self.assertEqual(
            {item["pid"]: item["role"] for item in result["processes"]},
            {
                100: "cli-controller",
                110: "cli-controller",
                120: "application",
                130: "native-host",
                140: "other-owned",
            },
        )

    def test_resource_snapshot_rejects_a_replaced_host(self):
        table = {100: row(100, 1, 10), 120: row(120, 100, 12)}
        with (
            patch.object(PROCESS.DRIVER, "process_table", return_value=table),
            self.assertRaisesRegex(RuntimeError, "identity changed"),
        ):
            self.audit().resource_snapshot(
                {"pid": 120, "start_ticks": 12}, {"pid": 130, "start_ticks": 13}
            )

    def test_identity_is_never_claimed_after_discovery_ends(self):
        table = {100: row(100, 1, 10), 120: row(120, 100, 12)}
        audit = self.audit(discovering=False)
        with (
            patch.object(PROCESS.DRIVER, "process_table", return_value=table),
            self.assertRaisesRegex(RuntimeError, "no new window ownership"),
        ):
            audit.identity(120, Path("/nonexistent"))

    def test_recorded_audit_errors_surface_from_every_check(self):
        audit = self.audit()
        audit.error = "Watch process evidence exceeded its bound"
        for operation in (
            audit.check,
            lambda: audit.identity(1, Path("/")),
            lambda: audit.resource_snapshot({}, {}),
        ):
            with self.assertRaisesRegex(RuntimeError, "exceeded its bound"):
                operation()

    def test_wait_for_exit_requires_the_direct_command_to_exit_first(self):
        audit = self.audit()
        audit.app.poll.return_value = None
        with self.assertRaisesRegex(RuntimeError, "must exit"):
            audit.wait_for_exit(0)
        self.assertTrue(audit.ownership.discovering)


if __name__ == "__main__":
    unittest.main()

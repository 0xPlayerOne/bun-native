"""Framing regression tests; never count these as platform ownership acceptance."""

import io
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from qualify_terminal_owner import injected_kill_exit, read_record, windows_listener_state


@unittest.skipIf(sys.platform == "win32", "Unix fd framing; Windows uses its bounded pipe reader")
class FramingTests(unittest.TestCase):
    def frame(self, data, close=True):
        read, write = os.pipe()
        os.write(write, data)
        if close:
            os.close(write)
        else:
            self.addCleanup(os.close, write)
        stream = os.fdopen(read, "rb", buffering=0)
        self.addCleanup(stream.close)
        return SimpleNamespace(stdout=stream, stderr=io.BytesIO(b"never read diagnostics"))

    def test_partial_receipt_has_absolute_deadline(self):
        process = self.frame(b'{"partial":', False)
        start = time.monotonic()
        with self.assertRaisesRegex(AssertionError, "deadline"):
            read_record(process, 0.03)
        self.assertLess(time.monotonic() - start, 0.5)

    def test_eof_never_reads_stderr(self):
        process = self.frame(b"")
        process.stderr = None
        with self.assertRaisesRegex(AssertionError, "eof"):
            read_record(process)

    def test_exact_frame_preserves_next_record(self):
        process = self.frame(b'{"a":1}\n{"b":2}\n')
        self.assertEqual(read_record(process), {"a": 1})
        self.assertEqual(read_record(process), {"b": 2})

    def test_malformed_and_non_object_rejected(self):
        for data in (b"invalid\n", b"[]\n", b"\xff\n"):
            with self.subTest(data=data), self.assertRaises(AssertionError):
                read_record(self.frame(data))

    def test_oversized_record_rejected(self):
        # A regular file avoids blocking the test writer on a small pipe buffer.
        import tempfile

        with tempfile.TemporaryFile() as stream:
            stream.write(b"x" * 16384)
            stream.seek(0)
            with self.assertRaisesRegex(AssertionError, "oversized"):
                read_record(SimpleNamespace(stdout=stream))


class WindowsObservationTests(unittest.TestCase):
    owned = {"port": 12345, "server": 101}
    control = {"port": 12346, "server": 102}

    def row(self, record, pid=None, status=psutil.CONN_LISTEN):
        return SimpleNamespace(
            laddr=SimpleNamespace(ip="127.0.0.1", port=record["port"]),
            status=status,
            pid=record["server"] if pid is None else pid,
        )

    def test_owned_listener_requires_exact_identity_before_cleanup(self):
        with patch(
            "qualify_terminal_owner.psutil.net_connections",
            return_value=[self.row(self.owned), self.row(self.control)],
        ) as snapshot:
            self.assertFalse(windows_listener_state(self.owned, self.control, True))
            snapshot.assert_called_once_with(kind="tcp4")
        for rows in (
            [],
            [self.row(self.control)],
            [self.row(self.owned, pid=999), self.row(self.control)],
        ):
            with (
                patch("qualify_terminal_owner.psutil.net_connections", return_value=rows),
                self.assertRaises(AssertionError),
            ):
                windows_listener_state(self.owned, self.control, True)

    def test_absence_requires_positive_unrelated_listener_and_no_reused_owned_port(self):
        with patch(
            "qualify_terminal_owner.psutil.net_connections", return_value=[self.row(self.control)]
        ):
            self.assertTrue(windows_listener_state(self.owned, self.control, False))
        for rows in (
            [],
            [self.row(self.owned), self.row(self.control)],
            [self.row(self.owned, pid=999), self.row(self.control)],
        ):
            with (
                patch("qualify_terminal_owner.psutil.net_connections", return_value=rows),
                self.assertRaises(AssertionError),
            ):
                windows_listener_state(self.owned, self.control, False)

    def test_denied_table_and_overflow_are_not_empty_success(self):
        with (
            patch(
                "qualify_terminal_owner.psutil.net_connections", side_effect=psutil.AccessDenied()
            ),
            self.assertRaises(psutil.AccessDenied),
        ):
            windows_listener_state(self.owned, self.control, False)
        with (
            patch(
                "qualify_terminal_owner.psutil.net_connections",
                return_value=[self.row(self.control)] * 65537,
            ),
            self.assertRaisesRegex(AssertionError, "overflow"),
        ):
            windows_listener_state(self.owned, self.control, False)

    def test_exact_kill_status_follows_pinned_injector_not_an_arbitrary_nonzero_exit(self):
        with patch("qualify_terminal_owner.sys.platform", "win32"):
            self.assertEqual(injected_kill_exit(), 15)
            self.assertEqual(injected_kill_exit(native_host=True), 15)
        with patch("qualify_terminal_owner.sys.platform", "linux"):
            self.assertEqual(injected_kill_exit(), 137)
            self.assertEqual(injected_kill_exit(native_host=True), -9)

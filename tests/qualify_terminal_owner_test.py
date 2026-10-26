"""Framing regression tests; never count these as platform ownership acceptance."""

import io
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from qualify_terminal_owner import read_record


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

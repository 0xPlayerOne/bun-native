"""In-process X11 window capture: encoding, bound and exclusivity, without a display."""

import importlib.util
import struct
import tempfile
import threading
import time
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

SCRIPT = (
    Path(__file__).resolve().parents[2] / "scripts/quality/native-window-capture.py"
)
SPEC = importlib.util.spec_from_file_location("native_window_capture", SCRIPT)
CAPTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE)


def decode(png):
    """Minimal reader for the exact PNG layout the capture writes."""
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError("Missing PNG signature")
    offset, chunks = 8, []
    while offset < len(png):
        (length,) = struct.unpack(">I", png[offset : offset + 4])
        kind = png[offset + 4 : offset + 8]
        body = png[offset + 8 : offset + 8 + length]
        (crc,) = struct.unpack(">I", png[offset + 8 + length : offset + 12 + length])
        if crc != zlib.crc32(kind + body):
            raise AssertionError(f"Bad CRC for {kind!r}")
        chunks.append((kind, body))
        offset += 12 + length
    width, height, depth, color, *_ = struct.unpack(">IIBBBBB", chunks[0][1])
    return (
        [kind for kind, _ in chunks],
        width,
        height,
        depth,
        color,
        zlib.decompress(chunks[1][1]),
    )


class EncodingTests(unittest.TestCase):
    def test_bgrx_rows_with_stride_padding_become_exact_rgb_scanlines(self):
        # Two 2-pixel rows, each padded to 12 bytes like an XImage scanline.
        raw = bytes(
            [1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9]
            + [7, 8, 9, 0, 10, 11, 12, 0, 9, 9, 9, 9]
        )
        rows = CAPTURE.rgb_rows(raw, 2, 2, 12)
        self.assertEqual(rows, bytes([0, 3, 2, 1, 6, 5, 4, 0, 9, 8, 7, 12, 11, 10]))

    def test_png_is_a_valid_8_bit_rgb_image_of_the_given_rows(self):
        rows = CAPTURE.rgb_rows(bytes(range(32)), 2, 4, 8)
        kinds, width, height, depth, color, pixels = decode(
            CAPTURE.png_bytes(2, 4, rows)
        )
        self.assertEqual(kinds, [b"IHDR", b"IDAT", b"IEND"])
        self.assertEqual((width, height, depth, color), (2, 4, 8, 2))
        self.assertEqual(pixels, rows)


class BoundTests(unittest.TestCase):
    def test_a_blocked_capture_fails_at_the_unchanged_bound_and_writes_nothing(self):
        release = threading.Event()

        def blocked(_window):
            release.wait(5)
            return 1, 1, b"\0\0\0\0"

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(CAPTURE, "_capture", blocked),
        ):
            path = Path(directory, "shot.png")
            started = time.monotonic()
            with self.assertRaisesRegex(TimeoutError, "0.2-second bound"):
                CAPTURE.capture_png("4194305", path, timeout=0.2)
            elapsed = time.monotonic() - started
            release.set()
            self.assertGreaterEqual(elapsed, 0.2)
            self.assertLess(elapsed, 1)
            self.assertFalse(path.exists())

    def test_capture_errors_reach_the_caller_and_write_nothing(self):
        def failed(_window):
            raise RuntimeError("XGetImage failed for the owned window (X error 8)")

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(CAPTURE, "_capture", failed),
        ):
            path = Path(directory, "shot.png")
            with self.assertRaisesRegex(RuntimeError, "X error 8"):
                CAPTURE.capture_png("4194305", path)
            self.assertFalse(path.exists())

    def test_capture_never_replaces_existing_evidence(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(CAPTURE, "_capture", lambda _window: (1, 1, b"\0\1\2\3")),
        ):
            path = Path(directory, "shot.png")
            path.write_bytes(b"earlier")
            with self.assertRaises(FileExistsError):
                CAPTURE.capture_png(1, path)
            self.assertEqual(path.read_bytes(), b"earlier")

    def test_success_reports_dimensions_and_time_inside_the_bound(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(CAPTURE, "_capture", lambda window: (1, 1, b"\0\1\2\3")),
        ):
            path = Path(directory, "shot.png")
            result = CAPTURE.capture_png("17", path, timeout=3)
            self.assertEqual((result["width"], result["height"]), (1, 1))
            self.assertLess(result["capture_ms"], 3000)
            self.assertEqual(decode(path.read_bytes())[5], b"\0\1\2\3")


if __name__ == "__main__":
    unittest.main()

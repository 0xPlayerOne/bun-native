"""The Windows workspace driver's X11-word translation and PNG writer.

No Win32 call, helper or host runs: the owned-window controller is a mock.
"""

import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import Mock, patch

from scripts.quality.native_harness import native_workspace_windows as DRIVER

ROOT = Path(__file__).resolve().parents[2]


def state(window="99"):
    return {
        "host": {"pid": 42},
        "window": {"id": window, "client": [100, 50, 1000, 760]},
    }


def commands(observed=None, foreground=True):
    windows = Mock()
    windows.observe.return_value = observed or state()
    windows.foreground.return_value = foreground
    driver = DRIVER.WindowsCommands(
        windows, "Title", lambda: [1000, 760], r"C:\ImageMagick\magick.exe"
    )
    driver.window = "99"
    return driver, windows


class WindowsCommandTests(unittest.TestCase):
    def test_focus_reports_the_owned_window_only_while_it_is_foreground(self):
        driver, _ = commands()
        self.assertEqual(driver.run(["xdotool", "getwindowfocus"]), "99")
        driver, _ = commands(foreground=False)
        self.assertEqual(driver.run(["xdotool", "getwindowfocus"]), "0")

    def test_geometry_is_the_owned_client_area(self):
        driver, _ = commands()
        fields = dict(
            line.split("=", 1)
            for line in driver.run(
                ["xdotool", "getwindowgeometry", "--shell", "99"]
            ).splitlines()
        )
        self.assertEqual(
            (fields["X"], fields["Y"], fields["WIDTH"], fields["HEIGHT"]),
            ("100", "50", "1000", "760"),
        )

    def test_click_wheel_key_type_resize_and_close_map_to_owned_actions(self):
        driver, windows = commands()
        driver.run(["xdotool", "mousemove", "--window", "99", 10, 20, "click", "1"])
        windows.click.assert_called_once_with(10.0, 20.0, [1000, 760])
        for button, notch in (("5", -1), ("4", 1)):
            windows.scroll.reset_mock()
            driver.run(
                [
                    "xdotool",
                    "mousemove",
                    "--window",
                    "99",
                    5,
                    6,
                    "click",
                    "--repeat",
                    "12",
                    "--delay",
                    "15",
                    button,
                ]
            )
            windows.scroll.assert_called_once_with(5.0, 6.0, [1000, 760], notch, 12, 15)
        driver.run(["xdotool", "key", "--clearmodifiers", "ctrl+a"])
        windows.key.assert_called_once_with("a", ["ctrl"])
        driver.run(["xdotool", "type", "--clearmodifiers", "--delay", "10", "Ship"])
        windows.type_printable.assert_called_once_with("Ship", 10)
        driver.run(["xdotool", "windowsize", "--sync", "99", "900", "700"])
        windows.resize.assert_called_once_with(900, 700)
        driver.run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
        windows.os_close.assert_called_once_with()

    def test_unknown_words_windows_and_keys_are_refused(self):
        driver, windows = commands()
        for command, message in (
            (["xdotool", "search", "x"], "No Windows equivalent"),
            (["import", "-window", "99", "x.png"], "No Windows equivalent"),
            (["xdotool", "windowsize", "--sync", "98", "960", "720"], "does not own"),
            (["xdotool", "key", "--clearmodifiers", "F5"], "Unsupported key"),
            (["xdotool", "key", "--clearmodifiers", "meta+a"], "Unsupported key"),
            (
                ["xdotool", "mousemove", "--window", "99", 1, 2, "click", "3"],
                "Unsupported pointer",
            ),
        ):
            with (
                self.subTest(command=command),
                self.assertRaisesRegex(RuntimeError, message),
            ):
                driver.run(command)
        windows.resize.assert_not_called()
        windows.key.assert_not_called()

    def test_a_changed_window_handle_is_an_error(self):
        driver, _ = commands(state(window="100"))
        with self.assertRaisesRegex(RuntimeError, "window handle changed"):
            driver.run(["xdotool", "getwindowfocus"])

    def test_image_commands_use_magick_never_windows_convert(self):
        driver, _ = commands()
        with patch.object(DRIVER.EVIDENCE, "run", return_value="ok") as run:
            self.assertEqual(driver.run(["convert", "a.png", "info:"]), "ok")
        run.assert_called_once_with(
            [r"C:\ImageMagick\magick.exe", "a.png", "info:"], timeout=10
        )

    def test_every_scenario_key_has_a_virtual_key(self):
        for name in ("Return", "Escape", "Tab", "BackSpace", "a"):
            self.assertIn(name, DRIVER.X11_KEYS)
        self.assertEqual(set(DRIVER.X11_MODIFIERS), {"ctrl", "shift", "alt", "super"})


class PngTests(unittest.TestCase):
    def test_bgra_rows_become_rgb_png_pixels(self):
        # Two pixels: pure red and the dark composer fill 0x222D3C.
        bgra = bytes((0, 0, 255, 255, 0x3C, 0x2D, 0x22, 255))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pixels.png"
            DRIVER.png(path, 2, 1, bgra)
            data = path.read_bytes()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        chunks, offset = {}, 8
        while offset < len(data):
            (length,) = struct.unpack(">I", data[offset : offset + 4])
            kind = data[offset + 4 : offset + 8]
            body = data[offset + 8 : offset + 8 + length]
            (crc,) = struct.unpack(
                ">I", data[offset + 8 + length : offset + 12 + length]
            )
            self.assertEqual(crc, zlib.crc32(kind + body) & 0xFFFFFFFF)
            chunks[kind] = body
            offset += 12 + length
        self.assertEqual(struct.unpack(">II", chunks[b"IHDR"][:8]), (2, 1))
        self.assertEqual(chunks[b"IHDR"][8:10], bytes((8, 2)))
        self.assertEqual(
            zlib.decompress(chunks[b"IDAT"]),
            bytes((0, 255, 0, 0, 0x22, 0x2D, 0x3C)),
        )


if __name__ == "__main__":
    unittest.main()

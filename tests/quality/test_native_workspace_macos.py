"""The macOS workspace driver's X11-word translation. No helper or host runs."""

import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_workspace_macos", ROOT / "scripts/quality/native-workspace-macos.py"
)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)
INPUT_SPEC = importlib.util.spec_from_file_location(
    "native_platform_input", ROOT / "scripts/quality/native-platform-input.py"
)
INPUT = importlib.util.module_from_spec(INPUT_SPEC)
INPUT_SPEC.loader.exec_module(INPUT)


def state(front=42):
    return {
        "status": "ready",
        "application": {"pid": 7},
        "host": {"pid": 42},
        "frontmostPID": front,
        "window": {
            "id": 99,
            "frame": [100, 50, 1000, 788],
            "titledContentSize": [1000, 760],
        },
    }


def commands(observed=None):
    mac = Mock()
    mac.observe.return_value = observed or state()
    driver = DRIVER.MacCommands(mac, "Title", lambda: [1000, 760], "/usr/bin/magick")
    driver.window = "99"
    return driver, mac


class MacCommandTests(unittest.TestCase):
    def test_focus_reports_the_owned_window_only_when_its_host_is_frontmost(self):
        driver, _ = commands()
        self.assertEqual(driver.run(["xdotool", "getwindowfocus"]), "99")
        driver, _ = commands(state(front=1))
        self.assertEqual(driver.run(["xdotool", "getwindowfocus"]), "0")

    def test_geometry_is_appkits_titled_content_size(self):
        driver, _ = commands()
        fields = dict(
            line.split("=", 1)
            for line in driver.run(
                ["xdotool", "getwindowgeometry", "--shell", "99"]
            ).splitlines()
        )
        self.assertEqual((fields["WIDTH"], fields["HEIGHT"]), ("1000", "760"))

    def test_click_wheel_key_type_resize_and_close_map_to_helper_actions(self):
        driver, mac = commands()
        driver.run(["xdotool", "mousemove", "--window", "99", 10, 20, "click", "1"])
        mac.click.assert_called_once_with(10.0, 20.0, [1000, 760])
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
                "30",
                "--delay",
                "10",
                "5",
            ]
        )
        mac.scroll.assert_called_once_with(5.0, 6.0, [1000, 760], -1, 30, 10)
        driver.run(["xdotool", "key", "--clearmodifiers", "ctrl+a"])
        mac.key.assert_called_once_with("a", ["control"])
        driver.run(["xdotool", "type", "--clearmodifiers", "--delay", "10", "Ship"])
        mac.type_printable.assert_called_once_with("Ship", 10)
        driver.run(["xdotool", "windowsize", "--sync", "99", "960", "720"])
        mac.resize.assert_called_once_with(960, 720, [1000, 760])
        driver.run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
        mac.os_close.assert_called_once_with()

    def test_wheel_up_is_a_positive_line(self):
        driver, mac = commands()
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
                "4",
            ]
        )
        mac.scroll.assert_called_once_with(5.0, 6.0, [1000, 760], 1, 12, 15)

    def test_unknown_words_windows_and_keys_are_refused(self):
        driver, mac = commands()
        for command, message in (
            (["xdotool", "search", "x"], "No macOS equivalent"),
            (["import", "-window", "99", "x.png"], "No macOS equivalent"),
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
        mac.resize.assert_not_called()
        mac.key.assert_not_called()

    def test_a_changed_window_number_is_an_error(self):
        changed = state()
        changed["window"]["id"] = 100
        driver, _ = commands(changed)
        with self.assertRaisesRegex(RuntimeError, "window number changed"):
            driver.run(["xdotool", "getwindowfocus"])

    def test_image_commands_use_the_installed_imagemagick(self):
        driver, _ = commands()
        with patch.object(DRIVER.EVIDENCE, "run", return_value="ok") as run:
            self.assertEqual(driver.run(["convert", "a.png", "info:"]), "ok")
        run.assert_called_once_with(["/usr/bin/magick", "a.png", "info:"], timeout=10)


class MacInputActionTests(unittest.TestCase):
    def mac(self):
        with (
            patch.object(
                INPUT.MacInput, "_call", return_value={"application": {"pid": 7}}
            ),
            patch.dict("os.environ", {"BUN_NATIVE_PLATFORM_HELPER": "/bin/sh"}),
        ):
            mac = INPUT.MacInput(7, "/host")
        mac.state = {**state(), "postEventAccess": True}
        return mac

    def test_actions_send_bounded_requests_with_the_observed_state(self):
        mac = self.mac()
        resized = {**state(), "application": {"pid": 7}, "injection": {}}
        with patch.object(INPUT.MacInput, "_call", return_value=resized) as call:
            mac.key("Return")
            mac.type_printable("Ship it", 10)
            mac.scroll(1, 2, [3, 4], -1, 30, 10)
            mac.os_close()
            mac.resize(960, 720, [1000, 760])
        actions = [entry.args[0] for entry in call.call_args_list]
        self.assertEqual(actions, ["key", "type", "scroll", "close", "resize"])
        self.assertEqual(call.call_args_list[0].kwargs["modifiers"], [])
        self.assertAlmostEqual(call.call_args_list[1].kwargs["timeout"], 3.07)
        self.assertAlmostEqual(call.call_args_list[2].kwargs["timeout"], 3.3)
        self.assertNotIn("injection", mac.state)

    def test_resize_refuses_a_different_application(self):
        mac = self.mac()
        with (
            patch.object(
                INPUT.MacInput, "_call", return_value={"application": {"pid": 8}}
            ),
            self.assertRaisesRegex(RuntimeError, "identity changed"),
        ):
            mac.resize(960, 720, [1000, 760])

    def test_requests_are_serialized_with_their_action(self):
        mac = self.mac()
        completed = Mock(
            returncode=0, stdout=json.dumps({"status": "ready"}).encode(), stderr=b""
        )
        with patch.object(INPUT.subprocess, "run", return_value=completed) as run:
            mac.key("a", ["control"])
        request = json.loads(run.call_args.args[0][1])
        self.assertEqual(
            (request["action"], request["key"], request["modifiers"]),
            ("key", "a", ["control"]),
        )


if __name__ == "__main__":
    unittest.main()

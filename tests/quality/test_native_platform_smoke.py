"""Portable paint expectation guards, separate from actual native execution."""

import copy
import ctypes
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_platform_smoke", ROOT / "scripts/quality/native-platform-smoke.py"
)
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class PlatformPaintOwnershipTests(unittest.TestCase):
    def test_a_prior_window_paint_cannot_qualify_a_reopened_window(self):
        prior = SMOKE.expected_paint(1, False, "test-nonce")
        reopened = SMOKE.expected_paint(2, False, "test-nonce")
        self.assertFalse(SMOKE.EVIDENCE.matches_paint(prior, reopened))
        self.assertTrue(SMOKE.EVIDENCE.matches_paint(reopened, reopened))
        self.assertTrue(all(node["node_id"] > 6 for node in reopened["nodes"]))

    def test_update_requires_the_full_text_and_independent_input_revision(self):
        expected = SMOKE.expected_paint(3, True, "test-nonce")
        self.assertEqual(expected["nodes"][-1]["input_revision"], 1)
        for field, value in (("input_revision", 0), ("children", [1])):
            damaged = copy.deepcopy(expected)
            damaged["nodes"][-1][field] = value
            self.assertFalse(SMOKE.EVIDENCE.matches_paint(damaged, expected))
        damaged = copy.deepcopy(expected)
        damaged["nodes"][2]["element"]["text"] = "Native update 2"
        self.assertFalse(SMOKE.EVIDENCE.matches_paint(damaged, expected))
        self.assertFalse(
            SMOKE.EVIDENCE.matches_paint({**expected, "status": "omitted"}, expected)
        )


class PlatformInputGuardTests(unittest.TestCase):
    """Pure guard tests, not claims that an OS accepted or delivered input."""

    def rows(self):
        return [
            {
                "type": "os-click",
                "cycle": 1,
                "kind": "button",
                "sequence": 3,
                "treeRevision": 1,
            },
            {
                "type": "os-input",
                "cycle": 1,
                "kind": "input",
                "sequence": 7,
                "treeRevision": 1,
                "revision": 1,
                "value": "a",
            },
            {
                "type": "os-input",
                "cycle": 1,
                "kind": "input",
                "sequence": 11,
                "treeRevision": 1,
                "revision": 2,
                "value": "ab",
            },
        ]

    def test_every_edit_is_required_but_unrelated_native_sequence_gaps_are_valid(self):
        result = SMOKE.OS_INPUT.input_delivery(self.rows(), 1, "ab", complete=True)
        self.assertEqual(
            result, {"complete": True, "clicks": 1, "edits": 2, "lastSequence": 11}
        )
        self.assertFalse(
            SMOKE.OS_INPUT.input_delivery(self.rows()[:-1], 1, "ab")["complete"]
        )
        with self.assertRaisesRegex(RuntimeError, "Not every"):
            SMOKE.OS_INPUT.input_delivery(self.rows()[:-1], 1, "ab", complete=True)

    def test_dropped_duplicate_stale_and_misrouted_native_edits_are_rejected(self):
        variants = [
            self.rows()[1:],
            [self.rows()[0], self.rows()[2]],
            [self.rows()[0], *self.rows()],
        ]
        for field, value in (
            ("sequence", True),
            ("sequence", 7),
            ("treeRevision", True),
            ("treeRevision", 2),
            ("revision", True),
            ("revision", 1),
            ("value", "aa"),
            ("kind", "button"),
        ):
            changed = self.rows()
            changed[-1][field] = value
            variants.append(changed)
        for rows in variants:
            with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                SMOKE.OS_INPUT.input_delivery(rows, 1, "ab", complete=True)

    def test_native_geometry_must_prove_a_finite_visible_target(self):
        layout = {
            "status": "complete",
            "viewport": [560, 380],
            "nodes": [
                {
                    "node_id": 4,
                    "bounds": [20, 100, 160, 44],
                    "ancestor_clip": [0, 0, 560, 380],
                }
            ],
        }
        self.assertEqual(
            SMOKE.OS_INPUT.pointer_target(layout, 4), (100, 122, [560, 380])
        )
        variants = [
            {**layout, "status": "omitted"},
            {**layout, "viewport": [True, 380]},
            {**layout, "nodes": []},
        ]
        for field, value in (
            ("bounds", [20, 100, float("nan"), 44]),
            ("bounds", [20, 100, -160, 44]),
            ("ancestor_clip", [0, 0, 50, 50]),
        ):
            changed = copy.deepcopy(layout)
            changed["nodes"][0][field] = value
            variants.append(changed)
        for candidate in variants:
            with self.subTest(candidate=candidate), self.assertRaises(RuntimeError):
                SMOKE.OS_INPUT.pointer_target(candidate, 4)

    @unittest.skipUnless(ctypes.sizeof(ctypes.c_void_p) == 8, "x64 controller ABI")
    def test_windows_structs_have_the_documented_x64_layout(self):
        windows = SMOKE.OS_INPUT.load("native-platform-windows")
        self.assertEqual(ctypes.sizeof(windows.ProcessEntry), 568)
        self.assertEqual(ctypes.sizeof(windows.MouseInput), 32)
        self.assertEqual(ctypes.sizeof(windows.KeyInput), 24)
        self.assertEqual(ctypes.sizeof(windows.Input), 40)

    def test_partial_windows_mouse_insertion_releases_only_its_own_down_event(self):
        windows = SMOKE.OS_INPUT.load("native-platform-windows")

        class User:
            def __init__(self, inserted):
                self.inserted = inserted
                self.calls = []

            def GetForegroundWindow(self):
                return 123

            def SendInput(self, count, values, _size):
                data = ctypes.cast(values, ctypes.POINTER(windows.Input))
                self.calls.append(
                    [data[index].data.mouse.flags for index in range(count)]
                )
                return self.inserted if len(self.calls) == 1 else count

        events = [
            windows.Input(
                0, windows.InputData(mouse=windows.MouseInput(0, 0, 0, flags, 0, 0))
            )
            for flags in (0xC001, 0xC002, 0xC004)
        ]
        for inserted, releases in ((0, []), (1, []), (2, [[4]])):
            controller = windows.WindowsInput.__new__(windows.WindowsInput)
            controller.window = 123
            controller.user = User(inserted)
            controller.verify = lambda: {}
            with (
                self.subTest(inserted=inserted),
                self.assertRaises(windows.InputUnavailable),
            ):
                controller._send(events)
            self.assertEqual(controller.user.calls[1:], releases)

    def test_windows_enumeration_does_not_swallow_callback_exceptions(self):
        windows = SMOKE.OS_INPUT.load("native-platform-windows")
        controller = windows.WindowsInput.__new__(windows.WindowsInput)
        controller.app = {"pid": 1}
        controller.host = {"pid": 2}
        controller._verify_process = lambda _process: None
        controller._desktop = lambda: {}
        controller._children = lambda: [2]
        controller.window_callback = ctypes.CFUNCTYPE(
            windows.BOOL, windows.HANDLE, ctypes.c_ssize_t
        )

        def invalid(_window):
            raise RuntimeError("owned window inspection failed")

        controller._visible_title = invalid

        class User:
            def GetWindowThreadProcessId(self, _window, pid):
                ctypes.cast(pid, ctypes.POINTER(windows.DWORD))[0] = 2
                return 1

            def EnumWindows(self, callback, data):
                return callback(123, data)

        controller.user = User()
        with self.assertRaisesRegex(RuntimeError, "owned window inspection failed"):
            controller.observe("owned fixture")

    def test_windows_input_desktop_query_closes_only_its_owned_handle(self):
        windows = SMOKE.OS_INPUT.load("native-platform-windows")

        class Kernel:
            def GetCurrentThreadId(self):
                return 7

        class User:
            def __init__(self, active):
                self.active = active
                self.closed = []

            def GetProcessWindowStation(self):
                return 1

            def GetThreadDesktop(self, _thread):
                return 2

            def OpenInputDesktop(self, _flags, _inherit, _access):
                return 3

            def CloseDesktop(self, handle):
                self.closed.append(handle)
                return True

            def GetUserObjectInformationW(self, handle, kind, value, _size, _needed):
                if kind == 1:
                    ctypes.cast(value, ctypes.POINTER(windows.UserObjectFlags))[
                        0
                    ].flags = 1
                else:
                    value.value = {1: "WinSta0", 2: "Default", 3: self.active}[handle]
                return True

        for active in ("Default", "Winlogon"):
            controller = windows.WindowsInput.__new__(windows.WindowsInput)
            controller.kernel = Kernel()
            controller.user = User(active)
            if active == "Default":
                self.assertEqual(
                    controller._desktop(),
                    {
                        "windowStation": "WinSta0",
                        "desktop": "Default",
                        "visibleSurface": True,
                    },
                )
            else:
                with self.assertRaises(windows.InputUnavailable):
                    controller._desktop()
            self.assertEqual(controller.user.closed, [3])

    def test_windows_recycled_parent_pid_cannot_claim_an_older_native_process(self):
        windows = SMOKE.OS_INPUT.load("native-platform-windows")
        controller = windows.WindowsInput.__new__(windows.WindowsInput)
        controller.app = {"pid": 1, "created": "200"}
        controller.host = None
        controller.host_path = Path("/owned/bun-native-host")
        controller.handles = [20]
        controller._verify_process = lambda _process: None
        controller._desktop = lambda: {}
        controller._children = lambda: [2]
        controller._open_process = lambda _pid: {
            "pid": 2,
            "created": "100",
            "image": str(controller.host_path),
            "handle": 20,
        }

        class Kernel:
            def __init__(self):
                self.closed = []

            def CloseHandle(self, handle):
                self.closed.append(handle)
                return True

        class User:
            def EnumWindows(self, _callback, _data):
                raise AssertionError(
                    "An older orphan must not reach window enumeration"
                )

        controller.kernel = Kernel()
        controller.user = User()
        self.assertIsNone(controller.observe("owned fixture"))
        self.assertIsNone(controller.host)
        self.assertEqual(controller.kernel.closed, [20])
        self.assertEqual(controller.handles, [])


if __name__ == "__main__":
    unittest.main()

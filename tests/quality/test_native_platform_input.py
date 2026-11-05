"""OS input adapter guards. No helper, X11 session or native host is executed."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_platform_input", ROOT / "scripts/quality/native-platform-input.py"
)
INPUT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INPUT)


def layout(bounds=(10, 20, 100, 40), clip=(0, 0, 640, 480), viewport=(640, 480)):
    return {
        "status": "complete",
        "viewport": list(viewport),
        "nodes": [
            {"node_id": 1, "bounds": [0, 0, 640, 480], "ancestor_clip": [0, 0, 1, 1]},
            {
                "node_id": 7,
                "bounds": list(bounds),
                "ancestor_clip": clip and list(clip),
            },
        ],
    }


class PointerTargetTests(unittest.TestCase):
    def test_returns_the_center_of_the_visible_target(self):
        self.assertEqual(INPUT.pointer_target(layout(), 7), (60.0, 40.0, [640, 480]))

    def test_incomplete_or_missing_geometry_is_rejected(self):
        incomplete = layout()
        incomplete["status"] = "partial"
        no_viewport = layout()
        no_viewport["viewport"] = [640]
        for value, node_id, message in (
            (None, 7, "Complete native geometry"),
            (incomplete, 7, "Complete native geometry"),
            (layout(), 8, "missing"),
            (no_viewport, 7, "missing"),
        ):
            with (
                self.subTest(message=message, node_id=node_id),
                self.assertRaisesRegex(RuntimeError, message),
            ):
                INPUT.pointer_target(value, node_id)

    def test_malformed_and_non_finite_geometry_is_rejected(self):
        cases = (
            (layout(bounds=(10, 20, 100)), "bounds are invalid"),
            (layout(clip=None), "bounds are invalid"),
            (layout(bounds=(10, 20, float("nan"), 40)), "finite numeric"),
            (layout(bounds=(10, 20, float("inf"), 40)), "finite numeric"),
            (layout(bounds=(True, 20, 100, 40)), "finite numeric"),
            (layout(viewport=("640", 480)), "finite numeric"),
            (layout(bounds=(10, 20, 0, 40)), "exceed their bound"),
            (layout(viewport=(40000, 480)), "exceed their bound"),
            (layout(clip=(0, 0, -1, 480)), "exceed their bound"),
        )
        for value, message in cases:
            with (
                self.subTest(message=message),
                self.assertRaisesRegex(RuntimeError, message),
            ):
                INPUT.pointer_target(value, 7)

    def test_clipped_or_offscreen_centers_are_rejected(self):
        for value in (
            layout(clip=(0, 0, 640, 30)),
            layout(clip=(61, 0, 100, 480)),
            layout(bounds=(600, 20, 100, 40)),
            layout(bounds=(-200, 20, 100, 40)),
        ):
            with (
                self.subTest(value=value["nodes"][1]),
                self.assertRaisesRegex(RuntimeError, "clipped or outside"),
            ):
                INPUT.pointer_target(value, 7)


def click(sequence, cycle=1, revision=1):
    return {
        "type": "os-click",
        "cycle": cycle,
        "sequence": sequence,
        "treeRevision": revision,
        "kind": "button",
    }


def edit(sequence, value, cycle=1, kind="input"):
    return {
        "type": "os-input",
        "cycle": cycle,
        "sequence": sequence,
        "treeRevision": 1,
        "revision": len(value),
        "value": value,
        "kind": kind,
    }


class InputDeliveryTests(unittest.TestCase):
    def test_complete_delivery_ignores_other_cycles_and_record_types(self):
        rows = [
            click(1, cycle=0),
            edit(2, "a", cycle=0),
            {"type": "mounted", "cycle": 1},
            click(3),
            edit(4, "a"),
            edit(9, "ab"),
        ]
        self.assertEqual(
            INPUT.input_delivery(rows, 1, "ab", complete=True),
            {"complete": True, "clicks": 1, "edits": 2, "lastSequence": 9},
        )

    def test_partial_delivery_is_reported_but_never_completes(self):
        rows = [click(1), edit(2, "a")]
        self.assertEqual(
            INPUT.input_delivery(rows, 1, "ab"),
            {"complete": False, "clicks": 1, "edits": 1, "lastSequence": 2},
        )
        self.assertFalse(INPUT.input_delivery([], 1, "ab")["complete"])
        with self.assertRaisesRegex(RuntimeError, "Not every expected"):
            INPUT.input_delivery(rows, 1, "ab", complete=True)

    def test_sequence_and_revision_must_be_strict_integers(self):
        for rows in (
            [click(2), edit(2, "a")],
            [click(2), edit(1, "a")],
            [click(True)],
            [click(1.0)],
            [click(0)],
            [click(1, revision=2)],
            [{**click(1), "treeRevision": None}],
        ):
            with (
                self.subTest(rows=rows),
                self.assertRaisesRegex(RuntimeError, "sequence or committed"),
            ):
                INPUT.input_delivery(rows, 1, "ab")

    def test_duplicated_or_misrouted_clicks_fail(self):
        for rows in (
            [click(1), click(2)],
            [click(1), edit(2, "a"), click(3)],
            [{**click(1), "kind": "input"}],
        ):
            with (
                self.subTest(rows=rows),
                self.assertRaisesRegex(RuntimeError, "duplicated or misrouted"),
            ):
                INPUT.input_delivery(rows, 1, "ab")

    def test_lost_duplicated_reordered_or_misrouted_edits_fail(self):
        for rows in (
            [edit(1, "a")],
            [click(1), edit(2, "b")],
            [click(1), edit(2, "ab")],
            [click(1), edit(2, "a"), edit(3, "a")],
            [click(1), edit(2, "a"), edit(3, "ab"), edit(4, "abc")],
            [click(1), edit(2, "a", kind="button")],
            [click(1), {**edit(2, "a"), "revision": True}],
        ):
            with (
                self.subTest(rows=rows),
                self.assertRaisesRegex(RuntimeError, "lost, duplicated"),
            ):
                INPUT.input_delivery(rows, 1, "ab")


class MacInputTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.helper = Path(directory.name) / "helper"
        self.helper.write_text("")
        environment = patch.dict(
            os.environ, {"BUN_NATIVE_PLATFORM_HELPER": str(self.helper)}
        )
        environment.start()
        self.addCleanup(environment.stop)

    @staticmethod
    def result(value, returncode=0, stderr=b""):
        stdout = value if isinstance(value, bytes) else json.dumps(value).encode()
        return subprocess.CompletedProcess([], returncode, stdout, stderr)

    def driver(self, *results):
        run = patch.object(INPUT.subprocess, "run", side_effect=list(results))
        mock = run.start()
        self.addCleanup(run.stop)
        return mock

    def test_helper_must_be_an_explicit_absolute_file(self):
        for value in ("", "relative/helper", str(self.helper.parent)):
            with (
                self.subTest(value=value),
                patch.dict(os.environ, {"BUN_NATIVE_PLATFORM_HELPER": value}),
                self.assertRaisesRegex(INPUT.InputUnavailable, "explicit"),
            ):
                INPUT.MacInput(1, "/host")

    def test_requests_are_bounded_json_and_identity_is_retained(self):
        run = self.driver(self.result({"status": "ready", "application": "app-1"}))
        mac = INPUT.MacInput(42, Path("/host"))
        self.assertEqual(mac.application, "app-1")
        arguments, options = run.call_args
        self.assertEqual(arguments[0][0], str(self.helper))
        self.assertEqual(
            json.loads(arguments[0][1]),
            {"action": "identity", "app_pid": 42, "host": "/host", "title": ""},
        )
        self.assertEqual(options["timeout"], 3)
        self.assertFalse(options["check"])

    def test_helper_failures_are_classified(self):
        cases = (
            (self.result(b"x" * 16385), RuntimeError, "output bound"),
            (self.result({}, stderr=b"x" * 16385), RuntimeError, "output bound"),
            (self.result(b"not json"), RuntimeError, "bounded JSON"),
            (self.result(b"\xff"), RuntimeError, "bounded JSON"),
            (
                self.result({"status": "unsupported", "error": "no session"}, 2),
                INPUT.InputUnavailable,
                "no session",
            ),
            (
                self.result({"status": "unsupported"}, 1),
                RuntimeError,
                "helper failed: 1",
            ),
            (self.result({"status": "ready"}, 3), RuntimeError, "helper failed: 3"),
            (self.result({"status": "other", "error": "bad"}), RuntimeError, "bad"),
        )
        for result, error, message in cases:
            with self.subTest(message=message, stdout=result.stdout[:16]):
                self.driver(result)
                with self.assertRaisesRegex(error, message) as raised:
                    INPUT.MacInput(1, "/host")
                if error is RuntimeError:
                    self.assertNotIsInstance(raised.exception, INPUT.InputUnavailable)

    def test_observe_requires_a_stable_application_identity(self):
        self.driver(
            self.result({"status": "ready", "application": "app-1"}),
            self.result({"status": "not-ready"}),
            self.result({"status": "ready", "application": "app-1", "x": 1}),
            self.result({"status": "ready", "application": "app-2"}),
        )
        mac = INPUT.MacInput(1, "/host")
        self.assertIsNone(mac.observe("Fixture"))
        self.assertIsNone(mac.state)
        self.assertEqual(mac.observe("Fixture")["x"], 1)
        self.assertEqual(mac.title, "Fixture")
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            mac.observe("Fixture")

    def test_input_requires_observation_and_explicit_posting_access(self):
        run = self.driver(self.result({"status": "ready", "application": "a"}))
        mac = INPUT.MacInput(1, "/host")
        with self.assertRaisesRegex(RuntimeError, "independently observed"):
            mac.tab()
        mac.state = {"postEventAccess": "yes"}
        with self.assertRaisesRegex(RuntimeError, "malformed"):
            mac.tab()
        mac.state = {"postEventAccess": False}
        with self.assertRaisesRegex(INPUT.InputUnavailable, "no input helper"):
            mac.type_text("ab")
        self.assertEqual(run.call_count, 1)

        mac.state = {"postEventAccess": True, "window": 3}
        run.side_effect = [self.result({"status": "ready"})]
        mac.click(5, 6, [640, 480])
        request = json.loads(run.call_args[0][0][1])
        self.assertEqual(request["action"], "click")
        self.assertEqual(request["expected"], mac.state)
        self.assertEqual((request["x"], request["y"]), (5, 6))
        self.assertEqual(request["viewport"], [640, 480])


class LinuxInputTests(unittest.TestCase):
    def diagnostics(self, identity=True):
        driver = Mock()
        driver.proc_identity_matches.return_value = identity
        return Mock(DRIVER=driver)

    def test_requires_consistent_process_identity(self):
        with self.assertRaisesRegex(INPUT.InputUnavailable, "namespace"):
            INPUT.LinuxInput(Mock(pid=1), Path("/host"), self.diagnostics(False))

    def test_text_injection_accepts_only_a_bounded_hex_nonce(self):
        linux = INPUT.LinuxInput(Mock(pid=1), Path("/host"), self.diagnostics())
        for text in ("", "ABC", "a b", "a;rm", "0" * 65, "g"):
            with (
                self.subTest(text=text),
                self.assertRaisesRegex(ValueError, "hexadecimal"),
            ):
                linux.type_text(text)
        linux.driver.run.assert_not_called()

    def test_click_scales_into_and_bounds_the_owned_window(self):
        diagnostics = self.diagnostics()
        linux = INPUT.LinuxInput(Mock(pid=1), Path("/host"), diagnostics)
        linux.pid, linux.window = 9, "77"
        geometry = "WINDOW=77\nX=0\nY=0\nWIDTH=1280\nHEIGHT=960"
        linux.driver.run.side_effect = lambda command: {
            "getwindowpid": "9",
            "getactivewindow": "77",
            "getwindowgeometry": geometry,
        }.get(command[1], "")
        result = linux.click(320, 240, [640, 480])
        self.assertEqual(result["windowPoint"], [640, 480])
        self.assertIn(
            ["xdotool", "mousemove", "--window", "77", "640", "480"],
            [call.args[0] for call in linux.driver.run.call_args_list],
        )
        with self.assertRaisesRegex(RuntimeError, "outside the owned window"):
            linux.click(640, 240, [640, 480])

    def test_foreground_failure_is_unavailable_input(self):
        linux = INPUT.LinuxInput(Mock(pid=1), Path("/host"), self.diagnostics())
        linux.pid, linux.window = 9, "77"
        linux.driver.run.side_effect = lambda command: {
            "getwindowpid": "9",
            "getactivewindow": "78",
        }.get(command[1], "")
        with self.assertRaisesRegex(INPUT.InputUnavailable, "cannot become active"):
            linux.tab()

    def test_replaced_window_process_is_rejected(self):
        linux = INPUT.LinuxInput(Mock(pid=1), Path("/host"), self.diagnostics())
        linux.pid, linux.window = 9, "77"
        linux.driver.run.return_value = "10"
        with self.assertRaisesRegex(RuntimeError, "process changed"):
            linux.tab()


class CreateTests(unittest.TestCase):
    def test_unsupported_platform_is_unavailable(self):
        with (
            patch.object(INPUT.sys, "platform", "sunos5"),
            self.assertRaisesRegex(INPUT.InputUnavailable, "No actual OS input"),
        ):
            INPUT.create(Mock(pid=1), Path("/host"), Mock())


if __name__ == "__main__":
    unittest.main()

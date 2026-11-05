"""Scenario guards for workspace and input-viewport flows.

These drive only the pure frame/geometry checks with recorded-shape fakes. No
X11 session, screenshot tool, GPU or native host is started, and none of these
tests claims native rendering.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "scripts/quality" / filename
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LAYOUT = load("native_layout", "native-layout-scenario.py")
REACT = load("native_react_workspace", "native-react-workspace-scenario.py")
SOLID = load("native_solid_workspace", "native-solid-workspace-scenario.py")
VIEWPORT = load("native_input_viewport", "native-input-viewport-scenario.py")


class Timeout(RuntimeError):
    pass


def wait_once(predicate, description):
    """A one-sample bounded wait: never retries, never relaunches."""
    value = predicate()
    if not value:
        raise Timeout(description)
    return value


def run_scenario(module, *, native=(), application=(), driver=None, output=None):
    driver = driver or Mock()
    require_owned = Mock()
    capture = Mock()
    with tempfile.TemporaryDirectory() as directory:
        return module.run(
            driver,
            LAYOUT,
            "4242",
            Path(output or directory),
            lambda: list(native),
            lambda: list(application),
            wait_once,
            require_owned,
            capture,
        )


class ReactDarkInputPixelTests(unittest.TestCase):
    LABELS = ("Add a task", "Search tasks", "Task title")

    def current(self, clip=(0, 0, 1000, 760)):
        return {
            "paint": {
                "nodes": [
                    {
                        "node_id": 10 + index,
                        "element": {"kind": "input", "placeholder": label},
                    }
                    for index, label in enumerate(self.LABELS)
                ]
                + [{"node_id": 99, "element": {"kind": "button", "text": "Add"}}]
            },
            "layout": {
                "viewport": [1000, 760],
                "nodes": [
                    {
                        "node_id": 10 + index,
                        "bounds": [20, 40 + 50 * index, 300, 36],
                        "ancestor_clip": list(clip),
                    }
                    for index in range(3)
                ],
            },
        }

    def driver(self, size="1000 760", background="222D3C", mean="0.25"):
        driver = Mock()
        driver.run.side_effect = lambda command: (
            f"{size} {background}" if "sRGB" in command else mean
        )
        return driver

    def test_samples_each_whole_input_inside_its_bounds(self):
        driver = self.driver()
        result = REACT.dark_input_pixels(
            driver, LAYOUT, Path("/shots/dark.png"), self.current()
        )
        self.assertEqual(
            result,
            {
                "Add a task": {
                    "background": "222D3C",
                    "expectedBackground": "222D3C",
                    "visibleForegroundFraction": 0.25,
                },
                "Search tasks": {
                    "background": "222D3C",
                    "expectedBackground": "222D3C",
                    "visibleForegroundFraction": 0.25,
                },
                "Task title": {
                    "background": "222D3C",
                    "expectedBackground": "151B24",
                    "visibleForegroundFraction": 0.25,
                },
            },
        )
        commands = [call.args[0] for call in driver.run.call_args_list]
        self.assertEqual(len(commands), 6)
        self.assertTrue(all(command[1] == "/shots/dark.png" for command in commands))
        # The background sample is two pixels inside the top-right corner, and
        # the foreground crop is inset four pixels and bounded.
        self.assertEqual(commands[0][-2], "%w %h %[hex:p{318,42}]")
        self.assertIn("256x28+24+44", commands[1])
        self.assertIn("256x28+24+144", commands[5])

    def test_partially_clipped_input_is_never_sampled(self):
        driver = self.driver()
        with self.assertRaisesRegex(RuntimeError, "whole native input"):
            REACT.dark_input_pixels(
                driver, LAYOUT, Path("dark.png"), self.current(clip=(0, 0, 200, 760))
            )
        driver.run.assert_not_called()

    def test_capture_must_match_the_native_viewport(self):
        with self.assertRaisesRegex(RuntimeError, "differ from the native viewport"):
            REACT.dark_input_pixels(
                self.driver(size="1000 761"), LAYOUT, Path("dark.png"), self.current()
            )

    def test_non_numeric_foreground_measurement_fails(self):
        with self.assertRaises(ValueError):
            REACT.dark_input_pixels(
                self.driver(mean="n/a"), LAYOUT, Path("dark.png"), self.current()
            )


class ReactFrameGuardTests(unittest.TestCase):
    def records(self, *, paint_revision=2, layout_revision=2, **layout):
        nodes = [
            {"node_id": 1, "element": {"kind": "box"}},
            {"node_id": 2, "element": {"kind": "box"}},
        ]
        return [
            {"type": "rendered", "tree_revision": paint_revision, "nodes": nodes},
            {
                "type": "layout",
                "tree_revision": layout_revision,
                "layout": {
                    "status": "complete",
                    "scale_factor": 1,
                    "nodes": nodes,
                    **layout,
                },
            },
        ]

    def test_non_unit_scale_geometry_fails_immediately(self):
        with self.assertRaisesRegex(RuntimeError, "scale-1") as raised:
            run_scenario(REACT, native=self.records(scale_factor=2))
        self.assertNotIsInstance(raised.exception, Timeout)

    def test_incomplete_or_uncorrelated_frames_are_not_settled(self):
        nodes_one = [{"node_id": 1, "element": {"kind": "box"}}]
        cases = {
            "no paint": self.records()[1:],
            "no geometry": self.records()[:1],
            "geometry newer than paint": self.records(layout_revision=3),
            "partial layout": self.records(status="partial"),
            "different live node set": self.records(nodes=nodes_one),
        }
        for name, records in cases.items():
            with (
                self.subTest(name),
                self.assertRaisesRegex(Timeout, "initial workspace paint"),
            ):
                run_scenario(REACT, native=records)

    def test_reused_older_geometry_settles_against_a_newer_paint(self):
        # Geometry is deduplicated across style-only commits; the first settled
        # frame then looks up the first task button, which this fake omits.
        with self.assertRaises(StopIteration):
            run_scenario(REACT, native=self.records(paint_revision=5))


class SolidScenarioTests(unittest.TestCase):
    def state(self, titles=None):
        titles = titles or SOLID.INITIAL_TITLES
        return {
            "selectedId": 1,
            "theme": "dark",
            "conversations": [
                {
                    "id": index + 1,
                    "title": title,
                    "messages": [{"id": n} for n in range(12)] if index == 0 else [],
                }
                for index, title in enumerate(titles)
            ],
        }

    def frame(self, state, labels=("You · 1",)):
        nodes = [
            {"node_id": 1, "element": {"kind": "box"}, "children": [2]},
            {"node_id": 2, "element": {"kind": "box"}, "children": [3]},
        ] + [
            {"node_id": 3 + index, "element": {"kind": "text", "text": label}}
            for index, label in enumerate(labels)
        ]
        for node in nodes[2:]:
            node["children"] = []
        return {
            "paint": {"nodes": nodes, "tree_revision": 1},
            "layout": {
                "viewport": [1000, 760],
                "focused_node_id": None,
                "nodes": [],
                "scrolls": [
                    {
                        "node_id": 1,
                        "offset": [0, 0],
                        "maximum": [0, 400],
                        "viewport": [100, 50, 600, 500],
                    }
                ],
            },
            "state": state,
        }

    def run_with(self, frame, state, driver=None):
        application = [{"type": "workspace-state", "state": state}]
        with patch.object(SOLID.PAINT, "frame", return_value=frame) as painted:
            try:
                return run_scenario(
                    SOLID,
                    native=[{"type": "rendered"}],
                    application=application,
                    driver=driver,
                )
            finally:
                painted.assert_called_with({"type": "rendered"}, None, state)

    def test_initial_conversation_titles_are_an_independent_oracle(self):
        state = self.state(["Project brief"])
        with self.assertRaises(AssertionError):
            self.run_with(self.frame(state), state)

    def test_ambiguous_native_label_is_rejected(self):
        state = self.state()
        with self.assertRaisesRegex(RuntimeError, "exactly one native text: You · 1"):
            self.run_with(self.frame(state, ("You · 1", "You · 1")), state)

    def test_input_is_never_sent_after_the_owned_window_loses_focus(self):
        state = self.state()
        driver = Mock()
        driver.run.return_value = "9999"
        with self.assertRaisesRegex(RuntimeError, "lost focus"):
            self.run_with(self.frame(state), state, driver)
        driver.run.assert_called_once_with(["xdotool", "getwindowfocus"])

    def test_initial_titles_are_unique(self):
        self.assertEqual(len(set(SOLID.INITIAL_TITLES)), len(SOLID.INITIAL_TITLES))
        self.assertEqual(len(set(REACT.INITIAL_TITLES)), len(REACT.INITIAL_TITLES))


class InputViewportScenarioTests(unittest.TestCase):
    def frame(self, x=20, width=400, line_width=600, viewport=(1200, 400)):
        return {
            "state": {
                "input": {"value": VIEWPORT.PAINT.INITIAL_VALUE, "revision": 0},
                "edits": 0,
                "restyled": False,
            },
            "input": {
                "node_id": 5,
                "viewport": [x, 40, width, 32],
                "line_width": line_width,
            },
            "layout": {"viewport": list(viewport)},
        }

    def run_with(self, frame, driver=None, output=None):
        application = [
            {"type": "mounted", "framework": "Solid"},
            {"type": "viewport-state", "state": {"marker": 1}},
        ]
        with patch.object(VIEWPORT.PAINT, "frame", return_value=frame) as painted:
            try:
                return run_scenario(
                    VIEWPORT,
                    native=[{"type": "layout"}, {"type": "rendered"}],
                    application=application,
                    driver=driver,
                    output=output,
                )
            finally:
                painted.assert_called_with(
                    {"type": "rendered"}, {"type": "layout"}, {"marker": 1}, "Solid"
                )

    def test_unexpected_initial_state_never_settles(self):
        frame = self.frame()
        frame["state"]["edits"] = 1
        with self.assertRaisesRegex(Timeout, "complete initial input viewport"):
            self.run_with(frame)

    def test_text_must_actually_overflow_the_input(self):
        with self.assertRaisesRegex(RuntimeError, "does not overflow"):
            self.run_with(self.frame(width=400, line_width=500))

    def test_visible_gutter_must_remain_beyond_the_text(self):
        with self.assertRaisesRegex(RuntimeError, "visible gutter"):
            self.run_with(self.frame(x=20, line_width=1160, viewport=(1200, 400)))

    def test_initial_observation_is_retained_before_any_input(self):
        driver = Mock()
        driver.run.return_value = "not-the-window"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "lost focus"):
                self.run_with(self.frame(), driver, directory)
            retained = json.loads(
                (Path(directory) / "input-viewport-observations.json").read_text()
            )
        self.assertEqual(retained, {"initial": self.frame()})
        driver.run.assert_called_once_with(["xdotool", "getwindowfocus"])


if __name__ == "__main__":
    unittest.main()

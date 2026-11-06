"""Missing scenario records fail with diagnostics, never a bare StopIteration."""

import importlib.util
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VIEWPORT = load(
    "input_viewport_scenario", "scripts/quality/native-input-viewport-scenario.py"
)
WORKSPACE = load(
    "react_workspace_scenario", "scripts/quality/native-react-workspace-scenario.py"
)


def never(*_arguments, **_keywords):
    raise AssertionError("A missing record must fail before any OS action")


class InputViewportScenarioTests(unittest.TestCase):
    def test_missing_mount_record_is_a_runtime_error(self):
        for records in ([], [{"type": "viewport-state"}], [{"type": "mounted"}]):
            with (
                self.subTest(records=records),
                self.assertRaisesRegex(RuntimeError, "never recorded its mount"),
            ):
                VIEWPORT.run(
                    mock.Mock(run=never),
                    None,
                    "1",
                    Path("/unused"),
                    list,
                    lambda records=records: records,
                    never,
                    never,
                    never,
                )


class ReactWorkspaceScenarioTests(unittest.TestCase):
    def test_require_returns_the_first_match_or_names_what_is_missing(self):
        self.assertEqual(WORKSPACE.require(iter([3, 4]), "a node"), 3)
        self.assertIsNone(WORKSPACE.require(iter([None]), "a node"))
        with self.assertRaisesRegex(RuntimeError, "missing the task list"):
            WORKSPACE.require(iter(()), "the task list")

    def frame(self, nodes):
        paint = {"tree_revision": 1, "nodes": nodes}
        layout = {
            "status": "complete",
            "scale_factor": 1,
            "nodes": [{"node_id": node["node_id"]} for node in nodes],
            "scrolls": [],
        }
        return [
            {"type": "rendered", "tree_revision": 1, **paint},
            {"type": "layout", "tree_revision": 1, "layout": layout},
        ]

    def test_missing_initial_task_is_a_runtime_error(self):
        records = self.frame(
            [
                {
                    "node_id": 1,
                    "children": [],
                    "element": {"kind": "button", "text": "Unrelated"},
                }
            ]
        )
        with self.assertRaisesRegex(RuntimeError, "Write the project brief"):
            WORKSPACE.run(
                mock.Mock(run=never),
                None,
                "1",
                Path("/unused"),
                lambda: records,
                list,
                lambda predicate, _description: predicate(),
                never,
                never,
            )

    def test_missing_dark_input_is_a_runtime_error(self):
        current = {"paint": {"nodes": []}, "layout": {"nodes": []}}
        with self.assertRaisesRegex(RuntimeError, "'Add a task' input paint"):
            WORKSPACE.dark_input_pixels(
                mock.Mock(run=never), None, Path("/unused"), current
            )


if __name__ == "__main__":
    unittest.main()

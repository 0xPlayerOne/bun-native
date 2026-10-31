"""Evidence route negatives; these tests do not stand in for native OS input."""

import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "native_interactions", ROOT / "scripts/quality/native-interactions-scenario.py"
)
INTERACTIONS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INTERACTIONS)


def records():
    path = ["root", "panel", "action"]
    return [
        {
            "type": "trace",
            "event": "pointer_down",
            "sequence": 9,
            "treeRevision": 2,
            "target": "action",
            "path": path.copy(),
            "currentTarget": target,
            "phase": phase,
            "capture": capture,
        }
        for target, phase, capture in (
            ("root", "capture", True),
            ("panel", "capture", True),
            ("action", "target", True),
            ("action", "target", False),
            ("panel", "bubble", False),
            ("root", "bubble", False),
        )
    ]


class NativeInteractionEvidenceTests(unittest.TestCase):
    def test_complete_route_is_checked_in_both_directions(self):
        expected = records()
        self.assertEqual(
            INTERACTIONS.route(expected, 9, ["root", "panel", "action"]), expected
        )
        for damaged in (
            expected[:-1],
            expected + [expected[-1]],
            list(reversed(expected)),
        ):
            with self.assertRaisesRegex(RuntimeError, "Incorrect native event route"):
                INTERACTIONS.route(damaged, 9, ["root", "panel", "action"])

    def test_stopping_at_target_distinguishes_its_two_bindings(self):
        expected = records()
        INTERACTIONS.route(expected[:4], 9, ["root", "panel", "action"], stop="stop")
        INTERACTIONS.route(
            expected[:3], 9, ["root", "panel", "action"], stop="immediate"
        )
        for rows, stop in (
            (expected[:3], "stop"),
            (expected[:4], "immediate"),
            (expected, "stop"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Incorrect native event route"):
                INTERACTIONS.route(rows, 9, ["root", "panel", "action"], stop=stop)

    def test_a_queued_event_cannot_be_attributed_to_new_ancestry(self):
        for field, value in (
            ("path", ["root", "alternate", "action"]),
            ("target", "replacement"),
        ):
            damaged = copy.deepcopy(records())
            damaged[3][field] = value
            with self.assertRaisesRegex(RuntimeError, "Incorrect native event route"):
                INTERACTIONS.route(damaged, 9, ["root", "panel", "action"])

    def test_one_sequence_cannot_change_kind_or_tree_revision(self):
        for field, value in (("event", "click"), ("treeRevision", 3)):
            damaged = copy.deepcopy(records())
            damaged[-1][field] = value
            with self.assertRaisesRegex(
                RuntimeError, "changed its type or committed revision"
            ):
                INTERACTIONS.route(damaged, 9, ["root", "panel", "action"])


if __name__ == "__main__":
    unittest.main()

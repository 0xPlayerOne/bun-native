"""Negative oracle controls only; these records are not native GUI evidence."""

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "solid_workspace_paint", ROOT / "scripts/quality/native-solid-workspace-paint.py"
)
PAINT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAINT)


def state():
    return {
        "conversations": [
            {"id": 1, "title": "Control conversation", "draft": "", "messages": []}
        ],
        "selectedId": 1,
        "theme": "dark",
        "details": True,
        "clearConfirmation": None,
    }


def records(snapshot=None):
    # A complete specimen lets each negative change one relevant property.
    # Actual app/source/paint correspondence is tested by the hosted scenario.
    nodes = []

    def flatten(tree):
        identity = len(nodes) + 1
        row = {"node_id": identity, "element": tree["element"], "children": []}
        nodes.append(row)
        if row["element"]["kind"] == "input":
            row["input_revision"] = 0
        row["children"] = [flatten(child) for child in tree["children"]]
        return identity

    flatten(PAINT.expected_tree(state() if snapshot is None else snapshot))
    paint = {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": 3,
        "nodes": nodes,
    }
    geometry = {
        "type": "layout",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": 3,
        "layout": {
            "status": "complete",
            "scale_factor": 1,
            "node_count": len(nodes),
            "nodes": [{"node_id": row["node_id"]} for row in nodes],
        },
    }
    return paint, geometry


class SolidWorkspacePaintControls(unittest.TestCase):
    def test_all_content_and_styles_are_required(self):
        paint, _ = records()
        self.assertTrue(PAINT.matches(paint, state()))
        for kind, field, value in (
            ("text", "text", "Unrelated text"),
            ("button", "disabled", True),
            ("input", "value", "Stale prompt"),
            ("input", "placeholder", "Different composer"),
            ("input", "style", {"background": 0xFFFFFF}),
            ("box", "style", {"height": 0}),
        ):
            with self.subTest(kind=kind, field=field):
                damaged = copy.deepcopy(paint)
                target = next(
                    row for row in damaged["nodes"] if row["element"]["kind"] == kind
                )
                target["element"][field] = value
                self.assertFalse(PAINT.matches(damaged, state()))

    def test_missing_extra_repeated_disconnected_and_cyclic_nodes_fail(self):
        paint, _ = records()
        for damage in (
            lambda rows: rows.pop(),
            lambda rows: rows.append(copy.deepcopy(rows[-1])),
            lambda rows: rows.append(
                {
                    "node_id": 999,
                    "element": {"kind": "text", "text": "", "style": {}},
                    "children": [],
                }
            ),
            lambda rows: rows[0]["children"].append(1),
            lambda rows: rows[0]["children"].append(rows[0]["children"][0]),
            lambda rows: rows[2]["children"].reverse(),
        ):
            damaged = copy.deepcopy(paint)
            damage(damaged["nodes"])
            self.assertFalse(PAINT.matches(damaged, state()))

    def test_foreign_window_omitted_paint_and_malformed_revision_fail(self):
        paint, _ = records()
        for field, value in (
            ("window_id", 2),
            ("window_id", True),
            ("tree_revision", True),
            ("tree_revision", 0),
            ("stage", "submitted"),
            ("status", "omitted"),
        ):
            damaged = {**paint, field: value}
            self.assertFalse(PAINT.matches(damaged, state()))
        for damaged in (
            None,
            [],
            {**paint, "nodes": [None]},
            {**paint, "nodes": [{"element": []}]},
        ):
            self.assertFalse(PAINT.matches(damaged, state()))
        damaged = copy.deepcopy(paint)
        next(row for row in damaged["nodes"] if row["element"]["kind"] == "input")[
            "input_revision"
        ] = True
        self.assertFalse(PAINT.matches(damaged, state()))

    def test_geometry_can_be_older_only_with_the_entire_same_live_node_set(self):
        paint, geometry = records()
        self.assertIsNotNone(PAINT.frame(paint, geometry, state()))
        newer_state = state()
        newer_state["conversations"][0]["draft"] = "New native edit"
        self.assertIsNone(PAINT.frame(paint, geometry, newer_state))
        geometry["tree_revision"] = 2
        self.assertIsNotNone(PAINT.frame(paint, geometry, state()))
        geometry["tree_revision"] = 4
        self.assertIsNone(PAINT.frame(paint, geometry, state()))
        for damage in (
            lambda row: row.update(window_id=2),
            lambda row: row.update(tree_revision=True),
            lambda row: row["layout"].update(scale_factor=2),
            lambda row: row["layout"].update(status="omitted"),
            lambda row: row["layout"]["nodes"].pop(),
            lambda row: row["layout"]["nodes"][-1].update(node_id=999),
            lambda row: row["layout"]["nodes"][-1].update(node_id=1),
            lambda row: row["layout"]["nodes"][-1].update(node_id=True),
        ):
            _, damaged = records()
            damage(damaged)
            self.assertIsNone(PAINT.frame(paint, damaged, state()))

    def test_completed_theme_paint_cannot_certify_the_prior_scroll_position(self):
        previous_paint, previous_geometry = records()
        previous_geometry["layout"]["scrolls"] = [
            {
                "node_id": 1,
                "offset": [0, -100],
                "maximum": [0, 100],
                "viewport": [0, 0, 200, 100],
            }
        ]
        changed_state = state()
        changed_state["theme"] = "light"
        changed_paint, _ = records(changed_state)
        changed_paint["tree_revision"] = 4
        changed_geometry = copy.deepcopy(previous_geometry)
        changed_geometry["tree_revision"] = 4
        changed_geometry["layout"]["scrolls"][0]["offset"] = [0, 0]
        self.assertEqual(
            [row["node_id"] for row in previous_paint["nodes"]],
            [row["node_id"] for row in changed_paint["nodes"]],
        )

        def observed_scrolls(changes):
            paint, geometry = previous_paint, previous_geometry
            observations = []
            for record in changes:
                if record["type"] == "rendered":
                    paint = record
                else:
                    geometry = record
                current = PAINT.frame(paint, geometry, changed_state)
                if current:
                    observations.append(current["layout"]["scrolls"][0]["offset"])
            return observations

        # The Rust writer regression enforces this order on actual file appends.
        # Every prefix either waits or observes the reset, never preservation.
        self.assertEqual(observed_scrolls([changed_geometry, changed_paint]), [[0, 0]])
        # Retain the original false-positive control: reversing publication
        # order exposes a spurious retained-scroll observation before the reset.
        self.assertEqual(
            observed_scrolls([changed_paint, changed_geometry]),
            [[0, -100], [0, 0]],
        )
        # If geometry really is unchanged, the completed paint may reuse it.
        self.assertEqual(observed_scrolls([changed_paint]), [[0, -100]])

    def test_session_states_change_the_expected_tree(self):
        def labels(tree):
            element = tree["element"]
            found = [element.get("text")] if "text" in element else []
            for child in tree["children"]:
                found += labels(child)
            return found

        def find(tree, label):
            if tree["element"].get("text") == label:
                return tree
            for child in tree["children"]:
                if result := find(child, label):
                    return result
            return None

        snapshot = state()
        snapshot["theme"] = "light"
        snapshot["details"] = False
        snapshot["conversations"].append(
            {"id": 2, "title": "Other conversation", "draft": "Next", "messages": []}
        )
        snapshot["conversations"][0].update(
            draft="Queued prompt",
            messages=[
                {"id": 1, "role": "user", "body": "Hello", "status": "complete"},
                {"id": 2, "role": "assistant", "body": "", "status": "streaming"},
            ],
        )
        snapshot["clearConfirmation"] = 1
        tree = PAINT.expected_tree(snapshot)
        found = labels(tree)
        self.assertTrue(PAINT.matches(records(snapshot)[0], snapshot))
        for label in (
            "You · 1",
            "Local assistant · 2",
            "Waiting for local text…",
            "Streaming locally",
            "Local reply in progress",
            "Clear this conversation's history?",
            "Confirm clear",
            "Keep history",
            "Use dark theme",
            "Show details",
        ):
            self.assertIn(label, found)
        self.assertNotIn("Workspace details", found)
        self.assertNotIn("No messages yet. Write a prompt below.", found)
        self.assertEqual(
            find(tree, "Other conversation")["element"]["style"]["background"], 0xFFFFFF
        )
        self.assertEqual(
            find(tree, "Control conversation")["element"]["style"]["background"],
            0xDCE9FF,
        )
        self.assertTrue(find(tree, "Send prompt")["element"]["disabled"])
        self.assertFalse(find(tree, "Cancel reply")["element"]["disabled"])
        self.assertFalse(find(tree, "Close conversation")["element"]["disabled"])

        # A confirmation for another conversation is not shown; finished
        # replies re-enable Send with a bounded draft.
        snapshot["clearConfirmation"] = 2
        snapshot["conversations"][0]["messages"][1].update(
            body="Done", status="cancelled"
        )
        found = labels(PAINT.expected_tree(snapshot))
        self.assertNotIn("Clear this conversation's history?", found)
        self.assertIn("Cancelled", found)
        self.assertIn("Local simulation · No backend connected", found)
        tree = PAINT.expected_tree(snapshot)
        self.assertFalse(find(tree, "Send prompt")["element"]["disabled"])
        self.assertTrue(find(tree, "Cancel reply")["element"]["disabled"])

    def test_send_follows_the_app_history_limit(self):
        def send_disabled(count):
            snapshot = state()
            snapshot["conversations"][0].update(
                draft="Another prompt",
                messages=[
                    {
                        "id": index + 1,
                        "role": "user" if index % 2 == 0 else "assistant",
                        "body": f"Message {index + 1}",
                        "status": "complete",
                    }
                    for index in range(count)
                ],
            )
            tree = PAINT.expected_tree(snapshot)
            composer = tree["children"][0]["children"][0]["children"][2]["children"][1][
                "children"
            ][3]
            limit = composer["children"][3]["element"]["text"]
            send = composer["children"][2]["children"][0]["element"]
            return send["disabled"], limit

        # The app allows a send while at most MAX_MESSAGES - 2 messages exist.
        self.assertEqual(
            send_disabled(22),
            (
                False,
                "Enter sends · Up to 240 characters · 24 messages per conversation",
            ),
        )
        self.assertEqual(
            send_disabled(24),
            (True, "History limit reached. Clear history to continue."),
        )

    def test_oversized_and_malformed_children_fail(self):
        paint, geometry = records()
        oversized = {
            **paint,
            "nodes": [
                {"node_id": index + 1, "element": {"kind": "text"}, "children": []}
                for index in range(257)
            ],
        }
        self.assertFalse(PAINT.matches(oversized, state()))
        self.assertFalse(PAINT.matches({**paint, "nodes": {}}, state()))
        damaged = copy.deepcopy(paint)
        damaged["nodes"][0]["children"] = None
        self.assertFalse(PAINT.matches(damaged, state()))
        self.assertIsNone(PAINT.frame(paint, {**geometry, "layout": []}, state()))
        self.assertIsNone(PAINT.frame(None, geometry, state()))
        self.assertIsNone(PAINT.frame(paint, geometry, None))


if __name__ == "__main__":
    unittest.main()

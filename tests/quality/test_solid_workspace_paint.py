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


def records():
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

    flatten(PAINT.expected_tree(state()))
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


if __name__ == "__main__":
    unittest.main()

"""Headless checks of the template desktop driver's evidence rules, not GUI acceptance."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "native/cli-templates-platform.py"
SPEC = importlib.util.spec_from_file_location("cli_templates_platform", SCRIPT)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)
TEMPLATES = DRIVER.TEMPLATES


def layout(button=(24.0, 122.0, 160.0, 44.0), revision=1, window_id=1):
    nodes = [
        {"node_id": 1, "bounds": [0, 0, 640, 480], "ancestor_clip": [0, 0, 640, 480]}
    ]
    nodes.append(
        {"node_id": 6, "bounds": list(button), "ancestor_clip": [0, 0, 640, 480]}
    )
    return {
        "type": "layout",
        "window_id": window_id,
        "tree_revision": revision,
        "layout": {"viewport": [640, 480], "status": "complete", "nodes": nodes},
    }


def trace(event, position, index, button="Left", window_id=1):
    return {
        "type": "pointer_trace",
        "stage": "gpui-window-input",
        "window_id": window_id,
        "event": event,
        "position": list(position),
        "button": button,
        "trace_index": index,
    }


class TemplatePlatformTests(unittest.TestCase):
    def test_click_targets_the_centre_of_the_painted_button(self):
        initial = TEMPLATES.counter_paint("solid", 0)
        target = DRIVER.button_target(layout()["layout"], initial)
        self.assertEqual(target["nodeId"], 6)
        self.assertEqual(target["logicalPoint"], [104.0, 144.0])
        self.assertEqual(target["bounds"], [24.0, 122.0, 160.0, 44.0])

    def test_click_target_requires_button_geometry(self):
        initial = TEMPLATES.counter_paint("react", 0)
        missing = layout()["layout"]
        missing["nodes"] = missing["nodes"][:1]
        with self.assertRaisesRegex(RuntimeError, "missing"):
            DRIVER.button_target(missing, initial)
        clipped = layout(button=(700, 122, 160, 44))["layout"]
        with self.assertRaisesRegex(RuntimeError, "outside"):
            DRIVER.button_target(clipped, initial)

    def test_layout_is_taken_for_the_requested_window_and_revision(self):
        records = [
            layout(revision=0),
            layout(button=(1, 1, 10, 10)),
            layout(window_id=2),
            layout(),
        ]
        self.assertEqual(
            DRIVER.latest_layout(records, 1, 1)["nodes"][1]["bounds"],
            [24.0, 122.0, 160.0, 44.0],
        )
        self.assertIsNone(DRIVER.latest_layout(records, 3, 1))

    def test_only_the_exact_counter_tree_counts_as_the_changed_label(self):
        clicked = TEMPLATES.counter_paint("react", 1)
        wrong = json.loads(json.dumps(clicked))
        wrong["nodes"][4]["element"]["text"] = "Clicks: 2"
        omitted = {**clicked, "status": "omitted"}
        self.assertIsNone(DRIVER.find_paint([wrong, omitted], clicked))
        self.assertEqual(DRIVER.find_paint([wrong, clicked], clicked), clicked)
        # The framework title is part of the tree: React's paint is not Solid's.
        self.assertIsNone(
            DRIVER.find_paint([clicked], TEMPLATES.counter_paint("solid", 1))
        )

    def test_later_paints_after_one_click_are_reported(self):
        records = [
            TEMPLATES.counter_paint("solid", 0),
            TEMPLATES.counter_paint("solid", 1),
        ]
        self.assertEqual(DRIVER.later_revisions(records, 1, 2), [])
        records.append(TEMPLATES.counter_paint("solid", 2))
        self.assertEqual(DRIVER.later_revisions(records, 1, 2), [3])
        self.assertEqual(DRIVER.later_revisions(records, 2, 2), [])

    def test_pointer_trace_needs_left_down_then_up_inside_the_button(self):
        bounds = [24.0, 122.0, 160.0, 44.0]
        click = [trace("down", (104.0, 144.0), 3), trace("up", (104.0, 144.0), 4)]
        self.assertEqual(DRIVER.pointer_click(click, 1, bounds)["up"]["trace_index"], 4)
        self.assertIsNone(DRIVER.pointer_click(click[:1], 1, bounds))
        self.assertIsNone(DRIVER.pointer_click(list(reversed(click)), 1, bounds))
        self.assertIsNone(DRIVER.pointer_click(click, 2, bounds))
        outside = [trace("down", (10.0, 10.0), 3), trace("up", (10.0, 10.0), 4)]
        self.assertIsNone(DRIVER.pointer_click(outside, 1, bounds))
        right = [
            trace("down", (104.0, 144.0), 3, "Right"),
            trace("up", (104.0, 144.0), 4, "Right"),
        ]
        self.assertIsNone(DRIVER.pointer_click(right, 1, bounds))
        # The far edges are outside the half-open bounds.
        edge = [trace("down", (184.0, 144.0), 3), trace("up", (184.0, 144.0), 4)]
        self.assertIsNone(DRIVER.pointer_click(edge, 1, bounds))

    def test_clean_close_requires_zero_exit_and_no_unexpected_host_exit(self):
        clean = {
            "exit_code": 0,
            "output": "Starting solid application with prebuilt host /h\n",
            "host_alive": False,
            "leftover_bundles": [],
        }
        self.assertEqual(DRIVER.close_errors(**clean), [])
        # The #584 reports: exit 1 and 130 with the runtime's host-exit error.
        self.assertEqual(
            DRIVER.close_errors(
                **{
                    **clean,
                    "exit_code": 1,
                    "output": "Native host exited unexpectedly (130).\n",
                }
            ),
            [
                "application exited 1",
                "application output reports 'exited unexpectedly'",
            ],
        )
        self.assertEqual(
            DRIVER.close_errors(**{**clean, "exit_code": 130}),
            ["application exited 130"],
        )
        self.assertIn(
            "application output reports 'NativeHostExitError'",
            DRIVER.close_errors(**{**clean, "output": "error: NativeHostExitError"}),
        )
        self.assertEqual(
            DRIVER.close_errors(
                **{**clean, "host_alive": True, "leftover_bundles": ["dev-1"]}
            ),
            [
                "the native host outlived the application",
                "development bundles were left behind: ['dev-1']",
            ],
        )

    def test_launch_runs_dev_on_a_fresh_copy_and_aot_with_its_adjacent_host(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "packages" / "solid-typescript"
            (case / "source").mkdir(parents=True)
            (case / "package").mkdir()
            entry = case / "source" / "main.tsx"
            entry.write_text("export {}\n")
            (case / "package" / "manifest.json").write_text(
                json.dumps(
                    {
                        "application": {"file": "application"},
                        "host": {"file": "bun-native-host"},
                    }
                )
            )
            provenance = {
                "compiler": {"path": "/pinned/bun"},
                "host": {"path": "/prepared/host"},
                "cases": {
                    "solid-typescript": {
                        "source": [{"path": "main.tsx", **TEMPLATES.artifact(entry)}]
                    }
                },
            }
            owned = root / "owned"
            owned.mkdir()
            command, cwd, host, project = DRIVER.launch(
                provenance, root / "packages", "solid-typescript", "development", owned
            )
            self.assertEqual(
                command,
                [
                    "/pinned/bun",
                    str(DRIVER.REPOSITORY / "scripts/native.ts"),
                    "dev",
                    str(owned / "project"),
                    "--host",
                    "/prepared/host",
                ],
            )
            self.assertEqual(cwd, DRIVER.REPOSITORY)
            self.assertEqual(host, Path("/prepared/host"))
            self.assertEqual((project / "main.tsx").read_text(), "export {}\n")
            command, cwd, host, project = DRIVER.launch(
                provenance, root / "packages", "solid-typescript", "aot", owned
            )
            self.assertEqual(command, [str(case / "package" / "application")])
            self.assertIsNone(cwd)
            self.assertEqual(host, case / "package" / "bun-native-host")
            self.assertIsNone(project)
            # A changed retained source is never launched.
            entry.write_text("export {} \n")
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                DRIVER.launch(
                    provenance,
                    root / "packages",
                    "solid-typescript",
                    "development",
                    root / "other",
                )


if __name__ == "__main__":
    unittest.main()

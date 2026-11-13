"""Headless checks of the native window-driver argument builders.

These scripts only compute independent expected trees and exec the shared
owned input driver. The tests replace ``os.execv`` so no native host, display
or input driver is ever launched.
"""

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from scripts.quality.native_harness import react_behavior as BEHAVIOR
from scripts.quality.native_harness import react_window as REACT_WINDOW
from scripts.quality.native_harness import renderer_interactions as RENDERER
from scripts.quality.native_harness import solid_window as SOLID_WINDOW

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "tests" / "native"
DRIVER = ROOT / "scripts" / "quality" / "native-input-linux.py"


ENV_KEYS = (
    "BUN_NATIVE_REACT_BEHAVIOR",
    "BUN_NATIVE_RENDERER_EVENT_SCENARIO",
    "BUN_NATIVE_SOLID_EVENT_SCENARIO",
)


class Executed(Exception):
    pass


def invoke(module, *arguments):
    """Run ``main`` with argv and return (exec argv, scenario environment)."""
    calls = []

    def execv(path, argv):
        calls.append((path, list(argv)))
        raise Executed

    with (
        patch.object(sys, "argv", ["script.py", *arguments]),
        patch.dict(os.environ, {}, clear=False),
        patch.object(module.os, "execv", execv),
    ):
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        try:
            module.main()
        except Executed:
            pass
        environment = {key: os.environ[key] for key in ENV_KEYS if key in os.environ}
    assert len(calls) == 1, calls
    path, argv = calls[0]
    assert path == sys.executable, path
    return argv, environment


def split(argv):
    """Split driver argv into (flag map, application command)."""
    separator = argv.index("--")
    driver, command = argv[:separator], argv[separator + 1 :]
    flags = {}
    index = 2
    while index < len(driver):
        flag = driver[index]
        values = []
        index += 1
        while index < len(driver) and not driver[index].startswith("--"):
            values.append(driver[index])
            index += 1
        flags.setdefault(flag, []).append(values)
    for name in ("--expect-initial-render", "--expect-render", "--expect-event"):
        if name in flags:
            flags[name] = json.loads(flags[name][0][0])
    return driver, flags, command


def assert_tree(case, nodes):
    """Every child edge resolves to a node and node ids are unique/sorted."""
    identities = [node["node_id"] for node in nodes]
    case.assertEqual(identities, sorted(set(identities)))
    for node in nodes:
        for child in node["children"]:
            case.assertIn(child, identities)


class DriverInvocationMixin:
    def assert_driver(self, argv, output, mode, title):
        driver, flags, _ = split(argv)
        self.assertEqual(driver[:2], [sys.executable, str(DRIVER)])
        self.assertEqual(flags["--output"], [[str(output)]])
        self.assertEqual(flags["--mode"], [[mode]])
        self.assertEqual(flags["--title"], [[title]])
        self.assertEqual(flags["--timeout"], [["30"]])
        self.assertEqual(flags["--expect-software-renderer"], [[]])
        return flags

    def assert_rejects_missing_command(self, module, *arguments):
        stderr = io.StringIO()
        with (
            patch.object(sys, "argv", ["script.py", *arguments]),
            patch.object(module.os, "execv") as execv,
            redirect_stderr(stderr),
            self.assertRaises(SystemExit) as raised,
        ):
            module.main()
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("supply the application command after --", stderr.getvalue())
        execv.assert_not_called()


class ReactWindowTests(DriverInvocationMixin, unittest.TestCase):
    def test_counter_tree_reorders_and_drops_beta_after_click(self):
        before = REACT_WINDOW.nodes(0, "")
        after = REACT_WINDOW.nodes(1, "")
        self.assertEqual(len(before), 13)
        self.assertEqual(len(after), 12)
        self.assertNotIn(12, [node["node_id"] for node in after])
        row = {node["node_id"]: node for node in after}[10]
        self.assertEqual(row["children"], [13, 11])
        self.assertEqual(
            {node["node_id"]: node for node in before}[10]["children"], [11, 12, 13]
        )
        assert_tree(self, before)
        assert_tree(self, after)

    def test_input_revision_counts_nonce_as_32_characters(self):
        node = {n["node_id"]: n for n in REACT_WINDOW.nodes(0, "React {nonce}")}[8]
        self.assertEqual(node["input_revision"], len("React ") + 32)
        self.assertEqual(node["element"]["value"], "React {nonce}")
        empty = {n["node_id"]: n for n in REACT_WINDOW.nodes(0, "")}[8]
        self.assertEqual(empty["input_revision"], 0)
        others = [n for n in REACT_WINDOW.nodes(0, "x") if n["node_id"] != 8]
        self.assertTrue(all("input_revision" not in n for n in others))

    def test_counter_click_argv(self):
        output = Path("evidence") / "react"
        argv, environment = invoke(
            REACT_WINDOW,
            "--scenario=counter-click",
            "--mode=aot",
            f"--output={output}",
            "--",
            "bun",
            "app.tsx",
        )
        flags = self.assert_driver(argv, output, "aot", "Bun Native React")
        self.assertEqual(split(argv)[2], ["bun", "app.tsx"])
        self.assertEqual(environment, {})
        self.assertEqual(flags["--click"], [["100", "130"]])
        self.assertNotIn("--key", flags)
        self.assertEqual(flags["--expect-initial-render"]["tree_revision"], 1)
        self.assertEqual(flags["--expect-render"]["tree_revision"], 2)
        self.assertEqual(flags["--expect-render"]["nodes"], REACT_WINDOW.nodes(1, ""))
        self.assertEqual(
            flags["--expect-event"],
            {"type": "click", "target": "increment", "stage": "bun-application"},
        )

    def test_counter_input_argv(self):
        argv, _ = invoke(
            REACT_WINDOW,
            "--scenario=counter-input",
            "--mode=development",
            "--output=out",
            "--",
            "bun",
        )
        flags = self.assert_driver(argv, Path("out"), "development", "Bun Native React")
        self.assertEqual(flags["--key"], [["ctrl+a"]])
        self.assertEqual(flags["--text"], [["React {nonce}"]])
        self.assertNotIn("--click", flags)
        final = flags["--expect-render"]
        self.assertNotIn("tree_revision", final)
        self.assertEqual(final["nodes"], REACT_WINDOW.nodes(0, "React {nonce}"))
        event = flags["--expect-event"]
        self.assertEqual(event["input_revision"], 38)
        node = {n["node_id"]: n for n in final["nodes"]}[8]
        self.assertEqual(event["input_revision"], node["input_revision"])

    def test_command_without_separator_is_kept_and_empty_is_rejected(self):
        argv, _ = invoke(
            REACT_WINDOW,
            "--scenario=counter-click",
            "--mode=aot",
            "--output=out",
            "bun",
        )
        self.assertEqual(split(argv)[2], ["bun"])
        self.assert_rejects_missing_command(
            REACT_WINDOW, "--scenario=counter-click", "--mode=aot", "--output=out"
        )
        self.assert_rejects_missing_command(
            REACT_WINDOW,
            "--scenario=counter-click",
            "--mode=aot",
            "--output=out",
            "--",
        )


class SolidWindowTests(DriverInvocationMixin, unittest.TestCase):
    def test_counter_tree_matches_react_except_title(self):
        for clicks, value in ((0, ""), (1, ""), (0, "Solid {nonce}")):
            solid = SOLID_WINDOW.counter_nodes(clicks, value)
            react = REACT_WINDOW.nodes(clicks, value)
            self.assertEqual(solid[3]["element"]["text"], "Bun Native Solid")
            solid[3]["element"]["text"] = react[3]["element"]["text"]
            self.assertEqual(solid, react)

    def test_interaction_tree_matches_shared_renderer_tree(self):
        for clicks, value in ((0, "ABCD"), (2, "ABCD"), (1, "AxBCD"), (1, "AYCD")):
            self.assertEqual(
                SOLID_WINDOW.interaction_nodes(clicks, value),
                RENDERER.nodes("Solid", clicks, value),
            )

    def test_intent_tree_revisions(self):
        before = {n["node_id"]: n for n in SOLID_WINDOW.intent_nodes(False)}
        after = {n["node_id"]: n for n in SOLID_WINDOW.intent_nodes(True)}
        self.assertEqual(before[5]["input_revision"], 0)
        self.assertEqual(before[5]["element"]["value"], "")
        self.assertEqual(before[6]["element"]["text"], "Revision: 0")
        # The explicit replacement is acknowledged one revision after the
        # typed revision the fixture displays.
        self.assertEqual(after[5]["input_revision"], 39)
        self.assertEqual(after[5]["element"]["value"], "Explicit replacement")
        self.assertEqual(after[6]["element"]["text"], "Revision: 38")
        assert_tree(self, list(after.values()))

    def run_scenario(self, scenario):
        return invoke(
            SOLID_WINDOW,
            f"--scenario={scenario}",
            "--mode=aot",
            "--output=out",
            "--",
            "bun",
        )

    def test_counter_and_intent_argv(self):
        argv, environment = self.run_scenario("counter-click")
        self.assertEqual(environment, {})
        flags = self.assert_driver(argv, Path("out"), "aot", "Bun Native Solid")
        self.assertEqual(flags["--click"], [["100", "130"]])
        self.assertEqual(flags["--expect-render"]["tree_revision"], 2)

        argv, _ = self.run_scenario("counter-input")
        flags = self.assert_driver(argv, Path("out"), "aot", "Bun Native Solid")
        self.assertEqual(flags["--text"], [["Solid {nonce}"]])
        self.assertNotIn("tree_revision", flags["--expect-render"])
        self.assertEqual(
            flags["--expect-render"]["nodes"],
            SOLID_WINDOW.counter_nodes(0, "Solid {nonce}"),
        )

        argv, _ = self.run_scenario("input-intent")
        flags = self.assert_driver(argv, Path("out"), "aot", "Bun Native Solid Input")
        self.assertEqual(flags["--key"], [["ctrl+a"]])
        self.assertEqual(
            flags["--expect-initial-render"]["nodes"], SOLID_WINDOW.intent_nodes(False)
        )
        self.assertEqual(
            flags["--expect-render"]["nodes"], SOLID_WINDOW.intent_nodes(True)
        )
        self.assertNotIn("tree_revision", flags["--expect-render"])
        self.assertEqual(flags["--expect-event"]["type"], "input")

    def test_interaction_argv_matches_shared_renderer_driver(self):
        for interaction in ("keyboard", "caret", "selection"):
            with self.subTest(interaction=interaction):
                solid, solid_env = self.run_scenario(f"interactions-{interaction}")
                shared, shared_env = invoke(
                    RENDERER,
                    "--renderer=Solid",
                    f"--scenario={interaction}",
                    "--mode=aot",
                    "--output=out",
                    "--",
                    "bun",
                )
                self.assertEqual(
                    solid_env, {"BUN_NATIVE_SOLID_EVENT_SCENARIO": interaction}
                )
                self.assertEqual(
                    shared_env, {"BUN_NATIVE_RENDERER_EVENT_SCENARIO": interaction}
                )
                _, solid_flags, _ = split(solid)
                _, shared_flags, _ = split(shared)
                for flag in (
                    "--click",
                    "--key",
                    "--text",
                    "--expect-initial-render",
                    "--expect-render",
                ):
                    self.assertEqual(
                        solid_flags.get(flag), shared_flags.get(flag), flag
                    )
                shared_event = dict(shared_flags["--expect-event"])
                self.assertEqual(shared_event.pop("framework"), "Solid")
                self.assertEqual(solid_flags["--expect-event"], shared_event)
                self.assertEqual(solid_flags["--title"], [["Bun Native Solid Events"]])

    def test_missing_command_is_rejected(self):
        self.assert_rejects_missing_command(
            SOLID_WINDOW, "--scenario=input-intent", "--mode=aot", "--output=out"
        )


class RendererInteractionsTests(DriverInvocationMixin, unittest.TestCase):
    def test_tree_titles_and_revisions(self):
        for framework in ("React", "Solid"):
            nodes = {n["node_id"]: n for n in RENDERER.nodes(framework, 0, "ABCD")}
            self.assertEqual(
                nodes[4]["element"]["text"], f"{framework} native event properties"
            )
            self.assertEqual(nodes[7]["input_revision"], 0)
            changed = {n["node_id"]: n for n in RENDERER.nodes(framework, 1, "AxBCD")}
            self.assertEqual(changed[7]["input_revision"], 1)
            self.assertEqual(changed[5]["element"]["text"], "Clicks: 1")
            self.assertEqual(changed[8]["element"]["text"], "Input: AxBCD")

    def test_scenario_key_sequences_and_expectations(self):
        cases = {
            "keyboard": ([["Return"]], None, "ABCD", 2, "click"),
            "caret": ([["Tab"], ["Home"], ["Right"]], [["x"]], "AxBCD", 1, "input"),
            "selection": (
                [["Tab"], ["Home"], ["Right"], ["shift+Right"]],
                [["Y"]],
                "AYCD",
                1,
                "input",
            ),
        }
        for renderer in ("React", "Solid"):
            for scenario, (keys, text, value, clicks, kind) in cases.items():
                with self.subTest(renderer=renderer, scenario=scenario):
                    argv, environment = invoke(
                        RENDERER,
                        f"--renderer={renderer}",
                        f"--scenario={scenario}",
                        "--mode=development",
                        "--output=out",
                        "--",
                        "bun",
                        "fixture.tsx",
                    )
                    flags = self.assert_driver(
                        argv,
                        Path("out"),
                        "development",
                        f"Bun Native {renderer} Events",
                    )
                    self.assertEqual(
                        environment,
                        {"BUN_NATIVE_RENDERER_EVENT_SCENARIO": scenario},
                    )
                    self.assertEqual(flags["--click"], [["100", "130"]])
                    self.assertEqual(flags["--key"], keys)
                    self.assertEqual(flags.get("--text"), text)
                    self.assertEqual(
                        flags["--expect-initial-render"]["nodes"],
                        RENDERER.nodes(renderer, 0, "ABCD"),
                    )
                    final = flags["--expect-render"]
                    self.assertEqual(final["tree_revision"], 3)
                    self.assertEqual(
                        final["nodes"], RENDERER.nodes(renderer, clicks, value)
                    )
                    event = flags["--expect-event"]
                    self.assertEqual(event["type"], kind)
                    self.assertEqual(event["framework"], renderer)
                    self.assertEqual(event["input"]["value"], value)
                    self.assertEqual(event["activations"], clicks)
                    self.assertEqual(split(argv)[2], ["bun", "fixture.tsx"])

    def test_unknown_renderer_is_rejected(self):
        with (
            patch.object(
                sys,
                "argv",
                [
                    "script.py",
                    "--renderer=Vue",
                    "--scenario=caret",
                    "--mode=aot",
                    "--output=out",
                    "--",
                    "bun",
                ],
            ),
            patch.object(RENDERER.os, "execv") as execv,
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            RENDERER.main()
        execv.assert_not_called()


class ReactBehaviorTests(DriverInvocationMixin, unittest.TestCase):
    def test_unknown_scenario_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown React behavior scenario"):
            BEHAVIOR.expectations("missing")

    def test_terminal_scenarios_are_known(self):
        self.assertTrue(set(BEHAVIOR.TERMINAL) <= set(BEHAVIOR.SCENARIOS))

    def test_labels(self):
        def label(scenario, final):
            texts = [
                node["element"].get("text")
                for node in BEHAVIOR.tree(scenario, final)
                if node["element"]["kind"] == "text"
            ]
            return texts[1]

        self.assertEqual(label("lifecycle", False), "State 0 / Reducer 0")
        self.assertEqual(label("lifecycle", True), "State 2 / Reducer 2")
        self.assertEqual(label("boundary-fallback", False), "Healthy 0")
        self.assertEqual(label("boundary-fallback", True), "Fallback")
        self.assertEqual(label("boundary-recovery", False), "Fallback")
        self.assertEqual(label("boundary-recovery", True), "Healthy 1")
        self.assertEqual(label("transition", False), "State 0")
        self.assertEqual(label("transition", True), "State 1")
        self.assertEqual(label("recoverable-retry", True), "State 2")

    def test_boundary_final_label_moves_to_node_seven(self):
        for scenario in ("boundary-fallback", "boundary-recovery"):
            final = BEHAVIOR.tree(scenario, True)
            identities = [node["node_id"] for node in final]
            self.assertEqual(identities, [1, 2, 3, 4, 6, 7])
            self.assertEqual(final[2]["children"], [4, 7, 6])
            initial = BEHAVIOR.tree(scenario, False)
            self.assertEqual([n["node_id"] for n in initial], [1, 2, 3, 4, 5, 6])

    def test_terminal_trees(self):
        for scenario in BEHAVIOR.TERMINAL:
            with self.subTest(scenario=scenario):
                initial = BEHAVIOR.tree(scenario, False)
                self.assertEqual(
                    [n["node_id"] for n in initial], [1, 2, 3, 4, 5, 6, 7, 8]
                )
                self.assertEqual(initial[0]["children"], [2, 7])
                self.assertEqual(initial[-1]["element"]["text"], "Survivor ready")
                final = BEHAVIOR.tree(scenario, True)
                self.assertEqual([n["node_id"] for n in final], [1, 7, 8])
                self.assertEqual(
                    final[-1]["element"]["text"], f"Survivor after {scenario}"
                )
                assert_tree(self, initial)
                assert_tree(self, final)

    def test_expectations_revisions_and_event_counts(self):
        for scenario in BEHAVIOR.SCENARIOS:
            with self.subTest(scenario=scenario):
                initial, final, event = BEHAVIOR.expectations(scenario)
                terminal = scenario in BEHAVIOR.TERMINAL
                self.assertEqual(initial["tree_revision"], 2 if terminal else 1)
                if terminal:
                    self.assertNotIn("tree_revision", final)
                else:
                    self.assertEqual(
                        final["tree_revision"],
                        3 if scenario == "recoverable-retry" else 2,
                    )
                self.assertEqual(event["terminalRejected"], terminal)
                self.assertEqual(
                    event["boundaryErrors"], int(scenario.startswith("boundary-"))
                )
                self.assertEqual(
                    event["recoveredErrors"],
                    int(scenario in ("recoverable-retry", "throwing-reporter")),
                )
                for render in (initial, final):
                    self.assertEqual(render["stage"], "native-paint")
                    self.assertEqual(render["window_id"], 1)

    def test_argv_and_environment(self):
        argv, environment = invoke(
            BEHAVIOR,
            "--scenario=cleanup-ref",
            "--mode=aot",
            "--output=out",
            "--",
            "bun",
            "behavior.tsx",
        )
        self.assertEqual(environment, {"BUN_NATIVE_REACT_BEHAVIOR": "cleanup-ref"})
        flags = self.assert_driver(
            argv, Path("out"), "aot", "Bun Native React Behavior"
        )
        initial, final, event = BEHAVIOR.expectations("cleanup-ref")
        self.assertEqual(flags["--expect-initial-render"], initial)
        self.assertEqual(flags["--expect-render"], final)
        self.assertEqual(flags["--expect-event"], event)
        self.assertEqual(flags["--click"], [["100", "130"]])
        self.assertEqual(split(argv)[2], ["bun", "behavior.tsx"])
        self.assert_rejects_missing_command(
            BEHAVIOR, "--scenario=lifecycle", "--mode=aot", "--output=out", "--"
        )


if __name__ == "__main__":
    unittest.main()

"""Negative controls for the long workspace session checks; not native evidence."""

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SESSION = load("workspace_session", "scripts/quality/native-workspace-session.py")
SOLID = load("solid_soak", "scripts/quality/native-solid-workspace-soak.py")
REACT = load("react_soak", "scripts/quality/native-react-workspace-soak.py")
RESOURCES = dict.fromkeys(SOLID.RESOURCE_KEYS, 0)
ROUNDS = 40


def process(rss):
    return {"rssKiB": rss, "hwmKiB": rss, "threads": 4, "fds": 9, "cpuTicks": 0}


def samples(rounds, every=10, step_ms=1000.0):
    return [
        {
            "round": mark,
            "elapsedMs": 1.0 + mark * step_ms,
            "objectCount": 10,
            "heapSize": 10,
            "bunRssBytes": 10,
            "hostRssKiB": 100 + mark,
            "host": process(100 + mark),
            "app": process(50),
            "loadAverage": [1.0, 1.0, 1.0],
        }
        for mark in [*range(0, rounds, every), rounds]
    ]


def session(input_key, rounds):
    return {
        "seconds": 30,
        "sampleSeconds": 10,
        "paceMs": 0,
        "osInput": {
            input_key: rounds,
            "typedCharacters": rounds * 10,
            "keys": rounds,
            "wheelNotches": rounds * 24,
        },
        "ackMs": {"count": 5, "p50": 1, "p95": 1, "p99": 1, "max": 1},
        "inputToStateMs": {"count": rounds * 2, "p50": 1, "p95": 1, "p99": 1, "max": 1},
    }


def solid_report(rounds=ROUNDS):
    replies = rounds * SOLID.SENDS_PER_ROUND
    return {
        "schemaVersion": 1,
        "status": "passed",
        "scenario": "solid-workspace-soak",
        "system": {"platform": "linux"},
        "rounds": rounds,
        "replies": replies,
        "completedReplies": replies // 2,
        "cancelledReplies": replies // 2,
        "ignoredStaleCallbacks": replies // 4,
        "scheduledTimers": replies // 4 * 23,
        "actions": 1000,
        "commits": 900,
        "elapsedMs": rounds * 1000.0 + 1,
        "roundDurationsMs": [1000.0] * rounds,
        "samples": samples(rounds),
        "session": session("typedPrompts", rounds),
        "final": {
            "application": dict(RESOURCES),
            "localWork": {
                "disposed": True,
                "pendingTimers": 0,
                "activeReplies": 0,
                "completedReplies": replies // 2,
                "cancelledReplies": replies // 2,
            },
        },
    }


def react_report(rounds=ROUNDS):
    plans = rounds * REACT.PLANS_PER_ROUND
    return {
        "schemaVersion": 1,
        "status": "passed",
        "scenario": "react-workspace-soak",
        "system": {"platform": "linux"},
        "rounds": rounds,
        "plans": plans,
        "completedPlans": plans // 2,
        "stoppedPlans": plans // 4,
        "switchedPlans": plans // 4,
        "ignoredStaleCallbacks": plans // 4,
        "scheduledTimers": plans // 4 * 23,
        "cancelledTimers": plans // 2,
        "actions": 1000,
        "commits": 900,
        "elapsedMs": rounds * 1000.0 + 1,
        "roundDurationsMs": [1000.0] * rounds,
        "samples": samples(rounds),
        "session": session("typedTasks", rounds),
        "final": {"application": dict(RESOURCES), "pendingTimers": 0},
    }


class LongSessionTest(unittest.TestCase):
    def test_complete_reports_pass_with_recomputed_totals(self):
        summary = SOLID.check(solid_report(), 30)
        self.assertEqual(summary["rounds"], ROUNDS)
        self.assertEqual(summary["replies"], ROUNDS * SOLID.SENDS_PER_ROUND)
        self.assertEqual(summary["series"]["hostRssKiB"]["last"], 100 + ROUNDS)
        # Linear growth of one KiB a round, a round a second: 3600 KiB/hour.
        self.assertAlmostEqual(
            summary["series"]["hostRssKiB"]["settledSlopePerHour"], 3600, places=0
        )
        self.assertEqual(summary["series"]["appRssKiB"]["settledSlopePerHour"], 0)
        self.assertEqual(REACT.check(react_report(), 30)["plans"], ROUNDS * 8)

    def test_fixed_and_long_modes_do_not_mix(self):
        with self.assertRaises(AssertionError):
            SOLID.check(solid_report())
        with self.assertRaises(AssertionError):
            REACT.check(react_report())
        fixed = solid_report(SOLID.ROUNDS)
        del fixed["session"]
        with self.assertRaises(AssertionError):
            SOLID.check(fixed, 30)

    def test_rejects_short_or_incomplete_sessions(self):
        changes = [
            lambda value: value.update(elapsedMs=29_000.0),
            lambda value: value["session"].update(seconds=20),
            lambda value: value.update(rounds=ROUNDS + 1),
            lambda value: value["roundDurationsMs"].pop(),
            lambda value: value["samples"].pop(),
            lambda value: value["samples"].pop(2),
            lambda value: value["samples"][1].update(host=None),
            lambda value: value["samples"][1]["app"].update(fds=0),
            lambda value: value["samples"][2].update(hostRssKiB=1),
            lambda value: value["session"]["osInput"].update(typedPrompts=ROUNDS - 1),
            lambda value: value["session"]["osInput"].update(keys=0),
            lambda value: value["session"]["osInput"].update(wheelNotches=1),
            lambda value: value["session"]["inputToStateMs"].update(count=1),
            lambda value: value["session"]["ackMs"].update(count=0),
            lambda value: value["final"]["application"].update(nodes=1),
            lambda value: value.update(scheduledTimers=1),
        ]
        for change in changes:
            value = copy.deepcopy(solid_report())
            change(value)
            with self.assertRaises((AssertionError, KeyError, TypeError)):
                SOLID.check(value, 30)

    def test_macos_sessions_have_no_peak_rss_and_fixed_mode_stays_linux(self):
        value = solid_report()
        value["system"]["platform"] = "darwin"
        for sample in value["samples"]:
            sample["host"]["hwmKiB"] = sample["app"]["hwmKiB"] = None
        self.assertEqual(SOLID.check(value, 30)["rounds"], ROUNDS)
        linux_without_peak = solid_report()
        linux_without_peak["samples"][1]["host"]["hwmKiB"] = None
        with self.assertRaises(AssertionError):
            SOLID.check(linux_without_peak, 30)
        value["samples"][1]["host"]["hwmKiB"] = 5
        with self.assertRaises(AssertionError):
            SOLID.check(value, 30)
        windows = solid_report()
        windows["system"]["platform"] = "win32"
        with self.assertRaises(AssertionError):
            SOLID.check(windows, 30)

    def test_a_session_without_os_input_needs_no_input_counts(self):
        value = solid_report()
        value["session"]["osInput"] = None
        self.assertIsNone(SOLID.check(value, 30)["osInput"])

    def test_phase_trace_summary_and_command_line(self):
        trace = {
            "schemaVersion": 1,
            "frameColumns": [
                "windowId",
                "startedNanos",
                "renderNanos",
                "renderToPaintNanos",
                "nodes",
            ],
            "renders": 5,
            "droppedFrames": 2,
            "frames": [
                [
                    1,
                    index * 1_000_000_000,
                    1_000_000,
                    None if index == 2 else 2_000_000,
                    9,
                ]
                for index in range(3)
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            phases = Path(directory) / "phases.json"
            phases.write_text(json.dumps(trace))
            frames = SESSION.summarize_phases(phases)
            self.assertEqual(
                frames,
                {
                    "renders": 5,
                    "recordedFrames": 3,
                    "droppedFrames": 2,
                    "coveredSeconds": 2.0,
                    "renderMs": {
                        "count": 3,
                        "p50": 1.0,
                        "p95": 1.0,
                        "p99": 1.0,
                        "max": 1.0,
                    },
                    "renderToPaintMs": {
                        "count": 2,
                        "p50": 2.0,
                        "p95": 2.0,
                        "p99": 2.0,
                        "max": 2.0,
                    },
                },
            )
            path = Path(directory) / "soak-result.json"
            path.write_text(json.dumps(react_report()))
            script = ROOT / "scripts/quality/native-react-workspace-soak.py"
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(script),
                    str(path),
                    "--long-session",
                    "30",
                    "--phases",
                    str(phases),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(json.loads(result.stdout)["hostFrames"], frames)
            for arguments in (
                [str(path), "--long-session"],
                [str(path), "--long-session", "30", "--phase", str(phases)],
                [str(path), "--long-session", "30", "--phases"],
            ):
                result = subprocess.run(
                    [sys.executable, "-I", str(script), *arguments],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 1, arguments)
                self.assertIn("usage: native-react-workspace-soak.py", result.stderr)


if __name__ == "__main__":
    unittest.main()

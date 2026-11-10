"""Negative report controls only; these records are not native GUI evidence."""

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "react_workspace_soak", ROOT / "scripts/quality/native-react-workspace-soak.py"
)
SOAK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOAK)


def report():
    plans = SOAK.ROUNDS * SOAK.PLANS_PER_ROUND
    return {
        "schemaVersion": 1,
        "status": "passed",
        "scenario": "react-workspace-soak",
        "system": {"platform": "linux"},
        "rounds": SOAK.ROUNDS,
        "plans": plans,
        "completedPlans": plans // 2,
        "stoppedPlans": plans // 4,
        "switchedPlans": plans // 4,
        "ignoredStaleCallbacks": plans // 4,
        "scheduledTimers": plans // 4 * 23,
        "cancelledTimers": plans // 2,
        "actions": 1000,
        "commits": 900,
        "elapsedMs": 1.0,
        "roundDurationsMs": [1.0] * SOAK.ROUNDS,
        "samples": [
            {
                "round": round,
                "objectCount": 10,
                "heapSize": 10,
                "bunRssBytes": 10,
                "hostRssKiB": 10,
            }
            for round in range(0, SOAK.ROUNDS + 1, SOAK.SAMPLE_EVERY)
        ],
        "final": {
            "application": dict.fromkeys(SOAK.RESOURCE_KEYS, 0),
            "pendingTimers": 0,
        },
    }


class SoakReportTest(unittest.TestCase):
    def test_complete_report_passes(self):
        self.assertEqual(SOAK.check(report())["rounds"], SOAK.ROUNDS)

    def test_rejects_changed_totals_and_retained_resources(self):
        changes = [
            lambda value: value.update(rounds=SOAK.ROUNDS - 1),
            lambda value: value.update(status="failed"),
            lambda value: value.update(cancelledTimers=0),
            lambda value: value.update(scheduledTimers=1),
            lambda value: value.update(stoppedPlans=0),
            lambda value: value.update(ignoredStaleCallbacks=0),
            lambda value: value["final"]["application"].update(nodes=1),
            lambda value: value["final"]["application"].pop("windows"),
            lambda value: value["final"].update(pendingTimers=1),
            lambda value: value["system"].update(platform="darwin"),
            lambda value: value["roundDurationsMs"].pop(),
            lambda value: value.update(commits=1),
            lambda value: value["samples"].pop(),
            lambda value: value["samples"][2].update(hostRssKiB=None),
            lambda value: value["samples"][1].update(objectCount=0),
            lambda value: value["samples"][3].update(bunRssBytes=0),
            lambda value: value["roundDurationsMs"].__setitem__(5, 0),
            lambda value: value.update(scenario="solid-workspace-soak"),
        ]
        for change in changes:
            value = copy.deepcopy(report())
            change(value)
            with self.assertRaises((AssertionError, KeyError)):
                SOAK.check(value)

    def test_summary_reports_first_warm_and_last_samples(self):
        value = report()
        for index, sample in enumerate(value["samples"]):
            sample.update(objectCount=index + 1, hostRssKiB=100 + index)
        summary = SOAK.check(value)
        self.assertEqual(summary["objectCount"], [1, 2, len(value["samples"])])
        self.assertEqual(summary["hostRssKiB"], [100, 101, 99 + len(value["samples"])])
        self.assertEqual(summary["plans"], SOAK.ROUNDS * SOAK.PLANS_PER_ROUND)

    def test_command_line_prints_summary_and_rejects_usage(self):
        script = ROOT / "scripts/quality/native-react-workspace-soak.py"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "soak-result.json"
            path.write_text(json.dumps(report()))
            result = subprocess.run(
                [sys.executable, "-I", str(script), str(path)],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(json.loads(result.stdout), SOAK.check(report()))
            failed = report()
            failed["status"] = "failed"
            path.write_text(json.dumps(failed))
            result = subprocess.run(
                [sys.executable, "-I", str(script), str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("status: expected 'passed'", result.stderr)
        result = subprocess.run(
            [sys.executable, "-I", str(script)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("usage: native-react-workspace-soak.py", result.stderr)


if __name__ == "__main__":
    unittest.main()

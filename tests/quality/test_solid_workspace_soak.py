"""Negative report controls only; these records are not native GUI evidence."""

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "solid_workspace_soak", ROOT / "scripts/quality/native-solid-workspace-soak.py"
)
SOAK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOAK)


def report():
    replies = SOAK.ROUNDS * SOAK.SENDS_PER_ROUND
    return {
        "schemaVersion": 1,
        "status": "passed",
        "scenario": "solid-workspace-soak",
        "system": {"platform": "linux"},
        "rounds": SOAK.ROUNDS,
        "replies": replies,
        "completedReplies": replies // 2,
        "cancelledReplies": replies // 2,
        "ignoredStaleCallbacks": replies // 4,
        "scheduledTimers": replies // 4 * 23,
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
            "localWork": {
                "disposed": True,
                "pendingTimers": 0,
                "activeReplies": 0,
                "completedReplies": replies // 2,
                "cancelledReplies": replies // 2,
            },
        },
    }


class SoakReportTest(unittest.TestCase):
    def test_complete_report_passes(self):
        self.assertEqual(SOAK.check(report())["rounds"], SOAK.ROUNDS)

    def test_rejects_changed_totals_and_retained_resources(self):
        changes = [
            lambda value: value.update(rounds=SOAK.ROUNDS - 1),
            lambda value: value.update(status="failed"),
            lambda value: value.update(cancelledReplies=0),
            lambda value: value.update(scheduledTimers=1),
            lambda value: value["final"]["application"].update(nodes=1),
            lambda value: value["final"]["application"].pop("windows"),
            lambda value: value["final"]["localWork"].update(pendingTimers=1),
            lambda value: value["system"].update(platform="darwin"),
            lambda value: value["roundDurationsMs"].pop(),
            lambda value: value.update(commits=1),
            lambda value: value["samples"].pop(),
            lambda value: value["samples"][2].update(hostRssKiB=None),
            lambda value: value["samples"][1].update(objectCount=0),
        ]
        for change in changes:
            value = copy.deepcopy(report())
            change(value)
            with self.assertRaises((AssertionError, KeyError)):
                SOAK.check(value)


if __name__ == "__main__":
    unittest.main()

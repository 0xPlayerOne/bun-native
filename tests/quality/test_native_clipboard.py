"""Clipboard evidence negatives; these do not substitute for actual X11 transfers."""

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "scripts/quality" / filename
    )
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


CLIPBOARD = module("clipboard_scenario", "native-clipboard-scenario.py")
DRIVER = module("clipboard_input_driver", "native-input-linux.py")


class ClipboardEvidenceTests(unittest.TestCase):
    def test_complete_native_paint_requires_every_node_and_current_input(self):
        expected = CLIPBOARD.paint(3, "Clipboard checks passed", "x")
        self.assertTrue(DRIVER.matches_paint(copy.deepcopy(expected), expected))
        altered = []
        missing = copy.deepcopy(expected)
        missing["nodes"].pop()
        altered.append(missing)
        stale = copy.deepcopy(expected)
        stale["nodes"][-1]["input_revision"] = 0
        altered.append(stale)
        wrong = copy.deepcopy(expected)
        wrong["nodes"][2]["element"]["text"] = "Clipboard ready"
        altered.append(wrong)
        omitted = copy.deepcopy(expected)
        omitted["status"] = "omitted"
        altered.append(omitted)
        for value in altered:
            with self.subTest(value=value):
                self.assertFalse(DRIVER.matches_paint(value, expected))

    def test_idle_check_rejects_polling_or_replaced_workers(self):
        before = {
            "tid": 42,
            "startTicks": "123",
            "state": "S",
            "cpuTicks": 0,
            "voluntarySwitches": 10,
            "involuntarySwitches": 0,
        }
        self.assertEqual(CLIPBOARD.verify_idle(before, before)["voluntarySwitches"], 0)
        for field, value in (
            ("tid", 43),
            ("startTicks", "124"),
            ("state", "R"),
            ("cpuTicks", 1),
            ("voluntarySwitches", 30),
            ("voluntarySwitches", 9),
        ):
            with (
                self.subTest(field=field, value=value),
                self.assertRaises(RuntimeError),
            ):
                CLIPBOARD.verify_idle(before, {**before, field: value})

    def test_result_requires_all_outcomes_and_exact_zero_ownership(self):
        application = {
            "outcomes": dict.fromkeys(CLIPBOARD.OUTCOMES, True),
            "ownership": dict.fromkeys(CLIPBOARD.OWNERSHIP, 0),
            "inputCount": 1,
            "peers": [
                {"label": label, "exitCode": 0, "records": [{"type": "stopped"}]}
                for label in sorted(CLIPBOARD.PEER_LABELS)
            ],
        }
        CLIPBOARD.validate_result(application)
        altered = []
        missing = copy.deepcopy(application)
        missing["outcomes"].pop("flood")
        altered.append(missing)
        false = copy.deepcopy(application)
        false["outcomes"]["flood"] = False
        altered.append(false)
        for field, value in (("serviceRequests", 1), ("unknown", 0), ("nodes", False)):
            live = copy.deepcopy(application)
            live["ownership"][field] = value
            altered.append(live)
        for exit_code in (1, False):
            failed = copy.deepcopy(application)
            failed["peers"][0]["exitCode"] = exit_code
            altered.append(failed)
        for field, value in (("inputCount", 0), ("inputCount", True), ("peers", [])):
            altered.append({**application, field: value})
        duplicate = copy.deepcopy(application)
        duplicate["peers"][0]["label"] = duplicate["peers"][1]["label"]
        altered.append(duplicate)
        for value in altered:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                CLIPBOARD.validate_result(value)


if __name__ == "__main__":
    unittest.main()

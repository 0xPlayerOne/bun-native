"""Independent negative-control acceptance, not fabricated process execution."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from cef_fault_control import accept_foreign_control


class ForeignControlAcceptanceTests(unittest.TestCase):
    def test_ready_independent_survivor_is_required(self):
        control = {
            "pid": 100,
            "creationTime": 1.25,
            "ready": True,
            "aliveAfterHostExit": True,
            "releasedNormally": True,
            "sameExecutableAsBackend": True,
        }
        observation = {"samples": [{"processes": [{"pid": 101}]}]}
        accept_foreign_control(control, observation)
        for field in ("ready", "aliveAfterHostExit", "releasedNormally", "sameExecutableAsBackend"):
            for value in (False, None, 1, "true"):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    accept_foreign_control({**control, field: value}, observation)
        for field in control:
            with self.assertRaises(ValueError):
                accept_foreign_control(
                    {key: value for key, value in control.items() if key != field}, observation
                )
        with self.assertRaises(ValueError):
            accept_foreign_control(control, {"samples": [{"processes": [{"pid": 100}]}]})

    def test_malformed_identity_and_unknown_metadata_are_not_accepted(self):
        control = {
            "pid": 100,
            "creationTime": 1.25,
            "ready": True,
            "aliveAfterHostExit": True,
            "releasedNormally": True,
            "sameExecutableAsBackend": True,
        }
        for field, value in (
            ("pid", 0),
            ("pid", True),
            ("pid", "100"),
            ("creationTime", 0),
            ("creationTime", float("nan")),
            ("creationTime", float("inf")),
            ("creationTime", True),
            ("extra", True),
        ):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                accept_foreign_control({**control, field: value}, {"samples": []})

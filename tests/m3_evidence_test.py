"""The preserved native reports must retain both positive and deliberate-failure evidence."""

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "report_m3_acceptance", ROOT / "scripts/report_m3_acceptance.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
read_reports, validate, verify = MODULE.read_reports, MODULE.validate, MODULE.verify


class M3EvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest, cls.reports = read_reports(ROOT / "evidence/m3-macos")

    def test_exact_retained_native_acceptance(self):
        summary = verify(ROOT / "evidence/m3-macos")
        self.assertTrue(summary["passed"])
        self.assertEqual(summary["prebuiltTrials"], 11)
        self.assertEqual(summary["faultCases"], 4)
        self.assertFalse(summary["windowsNativeQualified"])
        self.assertFalse(summary["linuxNativeQualified"])

    def test_missing_fault_or_forced_backend_exit_is_not_a_pass(self):
        changed = copy.deepcopy(self.reports)
        changed["faults"]["trials"].pop()
        with self.assertRaises(ValueError):
            validate(self.manifest, changed)
        changed = copy.deepcopy(self.reports)
        observation = changed["prebuilt"]["trials"][0]["observation"]
        observation["stderr"] = [
            line.replace('"forced":false', '"forced":true') for line in observation["stderr"]
        ]
        with self.assertRaises(ValueError):
            validate(self.manifest, changed)

    def test_unqualified_acquisition_or_volume_cleanup_cannot_pass(self):
        for report, field in [
            ("storage", "volumeDetached"),
            ("acquisition", "offlineCacheHit"),
            ("acquisition", "sourceClean"),
        ]:
            changed = copy.deepcopy(self.reports)
            changed[report][field] = False
            with self.assertRaises(ValueError):
                validate(self.manifest, changed)


if __name__ == "__main__":
    unittest.main()

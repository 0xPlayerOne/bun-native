"""Preserved-data reduction and explicit failure detection, not new native executions."""

import copy
import gzip
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import plistlib

from report_reference_acceptance import statistics_for, verify_matrix
from webkit_identity import parse


class ReportTests(unittest.TestCase):
    def test_statistics_keep_sample_counts_and_tail_values(self):
        result = statistics_for([1, 2, 3, 4])
        self.assertEqual(result["count"], 4)
        self.assertEqual(result["p50"], 2.5)
        self.assertAlmostEqual(result["p95"], 3.85)
        for value in ([], [float("nan")], [True], [-1]):
            with self.assertRaises(ValueError):
                statistics_for(value)

    def test_webkit_identity_requires_an_exact_installed_version(self):
        self.assertEqual(
            parse(plistlib.dumps({"CFBundleVersion": "21624.5.1.11.3"}))["bundleVersion"],
            "21624.5.1.11.3",
        )
        with self.assertRaises(ValueError):
            parse(plistlib.dumps({"CFBundleVersion": "unknown"}))

    def test_preserved_full_matrix_and_fault_injections(self):
        path = Path(__file__).resolve().parents[1] / "evidence/m2-measured/matrix.json.gz"
        with gzip.open(path, "rt") as source:
            matrix = json.load(source)
        verify_matrix(matrix)
        bad = copy.deepcopy(matrix)
        bad["trials"][0]["failed"] = "Idle reduction failed"
        with self.assertRaises(ValueError):
            verify_matrix(bad)
        bad = copy.deepcopy(matrix)
        bad["trials"][0] = bad["trials"][1]
        with self.assertRaises(ValueError):
            verify_matrix(bad)
        bad = copy.deepcopy(matrix)
        bad["trials"][0]["idle"]["sampledDurationMs"] = 0
        with self.assertRaises(ValueError):
            verify_matrix(bad)


if __name__ == "__main__":
    unittest.main()

"""Collector tests, not browser-HMR acceptance evidence."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "frontend_driver",
    Path(__file__).resolve().parents[1] / "benchmarks/adapters/frontend/driver.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompilerDiagnosticTests(unittest.TestCase):
    def test_actual_parser_rejection(self):
        self.assertIsNotNone(
            module.compiler_diagnostic(
                ["error: Unexpected ;", "    at /private/fixture/revision.ts:1:25"]
            )
        )

    def test_unrelated_error_is_not_invalid_edit(self):
        self.assertIsNone(
            module.compiler_diagnostic(
                ["error: Connection refused", "    at /fixture/revision.ts:1:25"]
            )
        )

    def test_other_source_cannot_satisfy_fixture(self):
        self.assertIsNone(
            module.compiler_diagnostic(["error: Unexpected ;", "    at /fixture/main.ts:1:25"])
        )

    def test_partial_output_waits_for_location(self):
        self.assertIsNone(module.compiler_diagnostic(["error: Unexpected ;"]))


if __name__ == "__main__":
    unittest.main()

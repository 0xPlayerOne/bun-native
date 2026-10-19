"""Read-only provider and error-classification checks."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import macos_sandbox


class SandboxTests(unittest.TestCase):
    def test_native_results_remain_distinct(self):
        for result, expected in [(0, False), (1, True), (-1, None), (2, None)]:
            with patch.object(macos_sandbox, "_CHECK", return_value=result):
                self.assertIs(macos_sandbox.presence(42)["active"], expected)

    def test_missing_provider_is_not_unsandboxed(self):
        with patch.object(macos_sandbox, "_CHECK", None):
            self.assertIsNone(macos_sandbox.presence(42)["active"])

    def test_invalid_pid_is_never_queried(self):
        for pid in [True, 0, -1, "42", 2**31]:
            with self.assertRaises(ValueError):
                macos_sandbox.presence(pid)


if __name__ == "__main__":
    unittest.main()

"""Data-only controls for the standalone cohort's error classification."""

import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "standalone_packages", ROOT / "scripts/quality/standalone-packages.py"
)
COHORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COHORT)


class CacheFailureTests(unittest.TestCase):
    def setUp(self):
        self.recorded = json.loads(
            (ROOT / "tests/fixtures/standalone-lock-diagnostics.json").read_text()
        )
        self.packages = {
            name: [f"{name}@{version}"]
            for name, version in self.recorded["registry_versions"].items()
        }

    def test_actual_mixed_lock_cache_error_is_not_a_clean_cache_negative(self):
        data = self.recorded["stderr"].encode()
        self.assertEqual(len(data), self.recorded["bytes"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), self.recorded["sha256"])
        self.assertIn(
            "Failed to resolve root dev dependency '@bun-native/cli'", data.decode()
        )
        self.assertFalse(
            COHORT.missing_registry_cache_failure(1, data.decode(), self.packages)
        )

    def test_synthetic_cache_only_and_wrong_reason_controls(self):
        # Removing the lock error is an inert predicate control, not an observed
        # corrected installation. The original recorded outcome stays unchanged.
        message = self.recorded["stderr"].split("Resolving dependencies\n", 1)[1]
        self.assertTrue(
            COHORT.missing_registry_cache_failure(1, message, self.packages)
        )
        # Pinned PackageManagerEnqueue::offline_miss/report_offline_misses emits
        # this archive-cache form when an already complete lock needs no manifest.
        self.assertTrue(
            COHORT.missing_registry_cache_failure(
                1, 'error: --offline: "@types/bun" is not in the cache\n', self.packages
            )
        )
        self.assertFalse(
            COHORT.missing_registry_cache_failure(0, message, self.packages)
        )
        self.assertFalse(
            COHORT.missing_registry_cache_failure(-15, message, self.packages)
        )
        self.assertFalse(
            COHORT.missing_registry_cache_failure(101, message, self.packages)
        )
        for invalid in (
            "warn: Ignoring lockfile\n" + message,
            "InvalidLockfile\n" + message,
            message.replace("@babel/core", "not-a-pinned-package"),
            message.replace("@babel/core@7.29.7", "@babel/core@7.29.8"),
            message + "error: cannot write installation directory\n",
        ):
            with self.subTest(invalid=invalid):
                self.assertFalse(
                    COHORT.missing_registry_cache_failure(1, invalid, self.packages)
                )


if __name__ == "__main__":
    unittest.main()

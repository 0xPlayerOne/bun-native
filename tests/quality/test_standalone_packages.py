"""Inert data/file controls; no package manager, installed module or app runs."""

import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.quality.native_harness import standalone_packages as COHORT

ROOT = Path(__file__).resolve().parents[2]


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


class InstalledMetadataTests(unittest.TestCase):
    def setUp(self):
        self.recorded = json.loads(
            (ROOT / "tests/fixtures/standalone-installer-tag.json").read_text()
        )
        self.temporary = tempfile.TemporaryDirectory(
            prefix="bun-native-inert-inventory-"
        )
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        self.package = self.project / "node_modules/@bun-native/cli"
        self.package.mkdir(parents=True)
        self.source = self.package / "index.ts"
        self.source.write_text("export {} // inert, never imported\n")
        self.tag = self.package / ".bun-tag"
        self.correct = self.recorded["tag"]["text"].encode()
        self.tag.write_bytes(self.correct)
        self.package_set = {
            "packages": {
                "@bun-native/cli": {
                    "files": {"index.ts": COHORT.digest(self.source)},
                    "archive": self.recorded["archive"],
                }
            }
        }

    def validate(self):
        return COHORT.installed_inventory(self.project, self.package_set)

    def test_exact_recorded_tag_and_declared_source_are_required(self):
        self.assertEqual(len(self.correct), self.recorded["tag"]["bytes"])
        self.assertEqual(
            hashlib.sha256(self.correct).hexdigest(), self.recorded["tag"]["sha256"]
        )
        self.assertEqual(len(self.correct), 52)
        self.assertEqual(len(self.recorded["canonical_lock_sri"]), 51)
        self.assertEqual(
            self.validate()["validated_local_packages"], ["@bun-native/cli"]
        )
        self.tag.unlink()
        with self.assertRaisesRegex(RuntimeError, "inventory differs"):
            self.validate()
        for invalid in (
            self.recorded["canonical_lock_sri"].encode(),
            self.correct + b"=",
            self.correct + b"\n",
            b"sha256-" + b"A" * 43 + b"==",
        ):
            with self.subTest(invalid=invalid):
                self.tag.write_bytes(invalid)
                with self.assertRaisesRegex(RuntimeError, "inventory differs"):
                    self.validate()
        self.tag.write_bytes(self.correct)
        self.source.write_text("changed inert source\n")
        with self.assertRaisesRegex(RuntimeError, "inventory differs"):
            self.validate()

    def test_nonregular_metadata_and_extra_entries_reject(self):
        self.tag.unlink()
        self.tag.mkdir()
        with self.assertRaisesRegex(RuntimeError, "inventory differs"):
            self.validate()
        self.tag.rmdir()
        if os.name != "nt":
            target = self.project / "correct-tag-outside-package"
            target.write_bytes(self.correct)
            self.tag.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "inventory differs"):
                self.validate()
            self.tag.unlink()
        self.tag.write_bytes(self.correct)
        for name in ("unexpected.txt", "nested/.bun-tag"):
            path = self.package / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(self.correct)
            with self.assertRaisesRegex(RuntimeError, "inventory differs"):
                self.validate()
            path.unlink()
            if path.parent != self.package:
                path.parent.rmdir()
        extra = self.package / "unexpected-empty-directory"
        extra.mkdir()
        with self.assertRaisesRegex(RuntimeError, "directory inventory differs"):
            self.validate()
        extra.rmdir()
        self.validate()

    def test_reserved_archive_metadata_cannot_replace_the_installer_record(self):
        for path in (".bun-tag", "nested/.bun-tag", ".bun-tag/child.ts"):
            invalid = copy.deepcopy(self.package_set)
            invalid["packages"]["@bun-native/cli"]["files"][path] = {
                "bytes": len(self.correct),
                "sha256": hashlib.sha256(self.correct).hexdigest(),
            }
            with (
                self.subTest(path=path),
                self.assertRaisesRegex(RuntimeError, "reserved installer metadata"),
            ):
                COHORT.installed_inventory(self.project, invalid)


if __name__ == "__main__":
    unittest.main()

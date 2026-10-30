"""Source/identity guard tests only; these never load or compile CEF."""

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import candidate


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run_git(root, *args):
    return (
        subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL)
        .decode()
        .strip()
    )


def commit(root):
    run_git(
        root,
        "-c",
        "user.name=Candidate Guard Test",
        "-c",
        "user.email=candidate-test@example.invalid",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "fixture",
    )
    return run_git(root, "rev-parse", "HEAD")


class SourceGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.package = self.root / "package"
        self.source.mkdir()
        self.package.mkdir()
        run_git(self.source, "init", "--quiet")
        for name in ("test-input.txt", "runtime-input.txt", "untouched.txt"):
            (self.source / name).write_text("before\n")
        run_git(self.source, "add", ".")
        base = commit(self.source)
        self.recipe = {
            "schema": 1,
            "status": "source-candidate-unqualified",
            "cefBaseCommit": base,
            "chromiumCommit": "a" * 40,
            "patchFormat": "git-diff-unified-zero",
            "patches": [],
            "variants": {},
        }
        for index, (name, path) in enumerate(
            (
                ("0001-test-input.patch", "test-input.txt"),
                ("0002-fix-input.patch", "runtime-input.txt"),
            )
        ):
            (self.source / path).write_text("after\n")
            patch = subprocess.check_output(
                [
                    "git",
                    "-C",
                    str(self.source),
                    "diff",
                    "--full-index",
                    "--unified=0",
                    "HEAD",
                    "--",
                    path,
                ]
            )
            (self.package / name).write_bytes(patch)
            self.recipe["patches"].append(
                {
                    "file": name,
                    "sha256": sha(patch),
                    "paths": [
                        {
                            "path": path,
                            "beforeSha256": sha(b"before\n"),
                            "afterSha256": sha(b"after\n"),
                        }
                    ],
                }
            )
            run_git(self.source, "add", path)
            variant = "baseline" if index == 0 else "candidate"
            self.recipe["variants"][variant] = {
                "tree": run_git(self.source, "write-tree"),
                "patches": [p["file"] for p in self.recipe["patches"]],
            }
        run_git(self.source, "restore", "--source=HEAD", "--staged", "--worktree", ".")
        (self.package / "source.json").write_text(json.dumps(self.recipe))
        self.recipe = candidate.load_recipe(self.package)

    def apply(self, variant="candidate"):
        return candidate.patch_source(
            self.source, self.recipe, variant, apply=True, package=self.package
        )

    def test_check_is_read_only_and_apply_requires_reviewed_tree(self):
        checked = candidate.patch_source(
            self.source, self.recipe, "candidate", package=self.package
        )
        self.assertFalse(checked["nativeExecutionQualified"])
        self.assertEqual("", run_git(self.source, "status", "--porcelain"))
        result = self.apply()
        self.assertEqual("staged", result["state"])
        self.assertFalse(result["nativeExecutionQualified"])
        with self.assertRaisesRegex(candidate.CandidateError, "Commit the reviewed"):
            candidate.verify_source(self.source, self.recipe, "candidate", require_commit=True)
        head = commit(self.source)
        result = candidate.verify_source(self.source, self.recipe, "candidate", require_commit=True)
        self.assertEqual(head, result["sourceCommit"])

    def test_baseline_has_tests_without_runtime_correction(self):
        result = self.apply("baseline")
        self.assertEqual("baseline", result["variant"])
        self.assertEqual("before\n", (self.source / "runtime-input.txt").read_text())
        with self.assertRaisesRegex(candidate.CandidateError, "reviewed variant"):
            candidate.verify_source(self.source, self.recipe, "candidate")

    def test_dirty_or_untracked_base_is_rejected_before_mutation(self):
        extra = self.source / "untracked.txt"
        extra.write_text("unrelated")
        with self.assertRaisesRegex(candidate.CandidateError, "no staged"):
            self.apply()
        self.assertEqual("before\n", (self.source / "test-input.txt").read_text())
        extra.unlink()
        (self.source / "runtime-input.txt").write_text("unrelated")
        run_git(self.source, "add", "runtime-input.txt")
        with self.assertRaisesRegex(candidate.CandidateError, "no staged"):
            self.apply()
        self.assertEqual("before\n", (self.source / "test-input.txt").read_text())

    def test_wrong_base_is_rejected(self):
        (self.source / "extra.txt").write_text("different source")
        run_git(self.source, "add", ".")
        commit(self.source)
        with self.assertRaisesRegex(candidate.CandidateError, "exact pinned base"):
            self.apply()

    def test_patch_tampering_is_rejected(self):
        patch = self.package / self.recipe["patches"][0]["file"]
        patch.write_bytes(patch.read_bytes() + b"\n")
        with self.assertRaisesRegex(candidate.CandidateError, "Patch digest"):
            candidate.load_recipe(self.package)

    def test_post_apply_edit_is_rejected(self):
        self.apply()
        (self.source / "runtime-input.txt").write_text("unexpected")
        with self.assertRaisesRegex(candidate.CandidateError, "differs from the index"):
            candidate.verify_source(self.source, self.recipe, "candidate")

    def test_assume_unchanged_cannot_hide_a_modified_base_file(self):
        run_git(self.source, "update-index", "--assume-unchanged", "untouched.txt")
        (self.source / "untouched.txt").write_text("concealed source change")
        with self.assertRaisesRegex(candidate.CandidateError, "Assume-unchanged"):
            self.apply()
        self.assertEqual("before\n", (self.source / "test-input.txt").read_text())

    def test_skip_worktree_cannot_hide_a_modified_committed_candidate(self):
        self.apply()
        commit(self.source)
        run_git(self.source, "update-index", "--skip-worktree", "untouched.txt")
        (self.source / "untouched.txt").write_text("concealed source change")
        with self.assertRaisesRegex(candidate.CandidateError, "skip-worktree"):
            candidate.verify_source(self.source, self.recipe, "candidate", require_commit=True)

    def test_extra_commit_is_not_the_reviewed_direct_candidate(self):
        self.apply()
        commit(self.source)
        (self.source / "extra.txt").write_text("unexpected")
        run_git(self.source, "add", ".")
        commit(self.source)
        with self.assertRaises(candidate.CandidateError):
            candidate.verify_source(self.source, self.recipe, "candidate", require_commit=True)


class IdentityGuardTest(unittest.TestCase):
    def setUp(self):
        self.recipe = candidate.load_recipe()
        self.source_commit = "b" * 40
        self.library_sha = "c" * 64
        self.identity = {
            "event": "cef-binary-identity",
            "schema": 1,
            "source": "exported-api",
            "sha256": self.library_sha,
            "cefVersion": "156.0.8",
            "cefCommitNumber": 1234,
            "chromiumVersion": self.recipe["chromiumVersion"],
            "fullVersion": (
                "156.0.8-initial-hidden.1234+gbbbbbbb+chromium-" + self.recipe["chromiumVersion"]
            ),
        }

    def verify(self):
        return candidate.verify_exported_identity(
            self.identity, self.source_commit, self.library_sha, self.recipe
        )

    def test_exact_declared_identity_is_consistent_without_claiming_execution(self):
        # Synthetic metadata exercises the parser only; no CEF module is loaded.
        self.assertEqual(self.identity["fullVersion"], self.verify())

    def test_stock_library_digest_is_rejected(self):
        self.library_sha = self.recipe["baselineLinuxLibrarySha256"]
        self.identity["sha256"] = self.library_sha
        with self.assertRaisesRegex(candidate.CandidateError, "Stock CEF"):
            self.verify()

    def test_stock_full_version_is_rejected_even_with_another_hash(self):
        self.identity["cefVersion"] = self.recipe["baselineCefVersion"]
        self.identity["fullVersion"] = "156.0.7+g47dbc1d+chromium-" + self.recipe["chromiumVersion"]
        with self.assertRaisesRegex(candidate.CandidateError, "exact candidate"):
            self.verify()

    def test_wrong_chromium_and_inconsistent_digest_are_rejected(self):
        self.identity["chromiumVersion"] = "156.0.8078.80"
        with self.assertRaisesRegex(candidate.CandidateError, "exact candidate"):
            self.verify()
        self.identity["chromiumVersion"] = self.recipe["chromiumVersion"]
        self.identity["sha256"] = "d" * 64
        with self.assertRaisesRegex(candidate.CandidateError, "inconsistent"):
            self.verify()

    def test_missing_full_version_is_rejected(self):
        del self.identity["fullVersion"]
        with self.assertRaisesRegex(candidate.CandidateError, "full CEF version"):
            self.verify()

    def test_failed_or_duplicate_probe_reports_are_rejected(self):
        observation = {
            "schema": 1,
            "exitCode": 0,
            "timedOut": False,
            "cancelled": False,
            "outputOverflow": False,
            "observerFailure": None,
            "cleanupSurvivors": [],
            "observedOrphans": [],
            "reports": [self.identity],
        }
        self.assertEqual(self.identity, candidate.identity_from_observation(observation))
        for key, value in (
            ("exitCode", 1),
            ("timedOut", True),
            ("observerFailure", "failed"),
            ("cleanupSurvivors", [1]),
            ("postExitCleanup", {"passed": False}),
            ("reports", [self.identity, self.identity]),
        ):
            with self.subTest(key=key), self.assertRaises(candidate.CandidateError):
                candidate.identity_from_observation({**observation, key: value})

    def test_cargo_stock_fallback_and_ambiguous_metadata_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured = root / "candidate"
            configured.mkdir()
            (configured / "libcef.so").write_bytes(b"hash-only test input")
            expected = sha(b"hash-only test input")
            stock = configured / "156.0.7" / "linux_x86_64"
            stock.mkdir(parents=True)
            output = root / "cargo-output.txt"
            output.write_text(f"cargo::metadata=CEF_DIR={stock}\n")
            with self.assertRaisesRegex(candidate.CandidateError, "stock fallback"):
                candidate.verify_linkage(output, configured, expected)
            output.write_text(f"cargo::metadata=CEF_DIR={configured}\n")
            candidate.verify_linkage(output, configured, expected)
            output.write_text(output.read_text() * 2)
            with self.assertRaisesRegex(candidate.CandidateError, "stock fallback"):
                candidate.verify_linkage(output, configured, expected)

    def test_library_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "regular"
            target.write_bytes(b"hash-only input")
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaisesRegex(candidate.CandidateError, "symbolic link"):
                candidate.digest_file(link)


class StableInputTest(unittest.TestCase):
    def test_json_replacement_before_open_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "input.json"
            replacement = root / "replacement.json"
            target.write_text('{"value":"original"}')
            replacement.write_text('{"value":"replaced"}')
            original_open = candidate.os.open

            def replace_then_open(path, flags):
                replacement.replace(target)
                return original_open(path, flags)

            with (
                mock.patch.object(candidate.os, "open", side_effect=replace_then_open),
                self.assertRaisesRegex(candidate.CandidateError, "before opening"),
            ):
                candidate.read_json(target)

    def test_metadata_replacement_during_read_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "cargo-output.txt"
            replacement = root / "replacement.txt"
            output.write_text(f"cargo::metadata=CEF_DIR={root}\n")
            replacement.write_text("replaced metadata")
            original_fstat = candidate.os.fstat
            calls = 0

            def replace_after_read(fd):
                nonlocal calls
                calls += 1
                if calls == 2:
                    replacement.replace(output)
                return original_fstat(fd)

            with (
                mock.patch.object(candidate.os, "fstat", side_effect=replace_after_read),
                self.assertRaisesRegex(candidate.CandidateError, "during verification"),
            ):
                candidate.verify_linkage(output, root, "a" * 64)


if __name__ == "__main__":
    unittest.main()

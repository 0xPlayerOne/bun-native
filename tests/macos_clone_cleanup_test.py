"""Adversarial local fixtures; these are policy tests, not native Chromium acceptance."""

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from macos_clone_cleanup import (  # noqa: E402
    MAX_CLONES,
    CloneCleanup,
    cleanup_suffix,
    executable_digest,
)
from macos_process_identity import MAX_PID_CANDIDATES, KernelIdentity  # noqa: E402


class SyntaxTests(unittest.TestCase):
    def test_only_exact_cleanup_argv_is_recognized(self):
        args = [
            "helper",
            "--type=code-sign-clone-cleanup",
            "--unique-temp-dir-suffix=abc123",
        ]
        self.assertEqual(cleanup_suffix(args), "abc123")
        self.assertEqual(cleanup_suffix([*args[:2], "--unique-temp-dir-suffix=a._-Z0"]), "a._-Z0")
        for wrong in (
            args + ["--no-wait-for-parent-exit-for-testing"],
            args[:2],
            [args[0], args[1], "--unique-temp-dir-suffix=../abc"],
            [args[0], args[1], "--unique-temp-dir-suffix=abc1234"],
            [args[0], "--type=renderer", args[2]],
            [args[0], args[2], args[1]],
        ):
            self.assertIsNone(cleanup_suffix(wrong))


@unittest.skipUnless(os.name == "posix", "POSIX inode provenance; native feature is macOS-only")
class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bunly-clone-policy-")
        self.base = Path(self.temp.name)
        self.app = self.base / "private.app"
        self.main = self.app / "Contents/MacOS/bunly_host"
        self.helper = (
            self.app / "Contents/Frameworks/bunly_host Helper.app/Contents/MacOS/bunly_host Helper"
        )
        self.main.parent.mkdir(parents=True)
        self.helper.parent.mkdir(parents=True)
        self.main.write_bytes(b"fixture main")
        self.helper.write_bytes(b"fixture helper")
        self.namespace = self.base / "clones"
        self.namespace.mkdir(mode=0o700)
        self.clone = self.namespace / "code_sign_clone.abc123"
        self.clone.mkdir(mode=0o700)
        cloned_main = self.clone / (self.app.name + ".bundle") / "Contents/MacOS/bunly_host"
        cloned_main.parent.mkdir(parents=True)
        os.link(self.main, cloned_main)
        self.root = SimpleNamespace(
            pid=100,
            create_time=lambda: 1.0,
            exe=lambda: str(self.main),
            uids=lambda: SimpleNamespace(real=os.getuid()),
        )
        self.birth = 2.0
        self.parent = 100
        self.executable = self.helper
        self.args = [
            str(self.helper),
            "--type=code-sign-clone-cleanup",
            "--unique-temp-dir-suffix=abc123",
        ]
        self.proc = SimpleNamespace(
            pid=101,
            create_time=lambda: self.birth,
            ppid=lambda: self.parent,
            exe=lambda: str(self.executable),
            cmdline=lambda: self.args,
            uids=lambda: SimpleNamespace(real=os.getuid()),
            status=lambda: psutil.STATUS_RUNNING,
        )
        self.processes = {100: self.root, 101: self.proc}

        def lookup(pid):
            if pid not in self.processes:
                raise psutil.NoSuchProcess(pid)
            return self.processes[pid]

        self.patch = patch("macos_clone_cleanup.psutil.Process", side_effect=lookup)
        self.patch.start()
        self.tracker = CloneCleanup(self.app, self.helper, self.namespace)
        self.tracker.bind(self.root)
        self.tracker.discover_clones()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def qualify(self):
        self.tracker.remember((101, 2.0), self.proc)
        self.assertIn((101, 2.0), self.tracker.helpers)

    def retained_tracker(self):
        self.kernel_rows = {
            100: KernelIdentity(1000, 500, 1, b"a" * 16),
            101: KernelIdentity(1001, 1000, 1, b"b" * 16),
        }
        self.kernel = Mock()
        self.kernel.identity.side_effect = lambda pid: self.kernel_rows.get(pid)
        self.kernel.same_uid_pids.return_value = [101]
        tracker = CloneCleanup(self.app, self.helper, self.namespace, kernel=self.kernel)
        tracker.bind(self.root)
        tracker.discover_clones()
        self.parent = 1
        del self.processes[100]
        return tracker

    def test_reparented_helper_requires_retained_kernel_parent_and_exact_clone(self):
        tracker = self.retained_tracker()
        self.assertEqual(tracker.recover_after_exit(), [((101, 2.0), self.proc)])
        self.assertTrue(tracker.grant((101, 2.0)))
        self.assertEqual(tracker.recover_after_exit(), [])
        self.kernel.same_uid_pids.assert_called_once()
        row = tracker.report(500)["helpers"][0]
        self.assertEqual(row["ownership"], "retained-kernel-parent-and-matching-clone-inode")
        self.assertEqual(
            row["kernelIdentity"],
            {"rootUniqueId": "1000", "uniqueId": "1001", "parentUniqueId": "1000"},
        )
        self.assertFalse(row["completed"])

    def test_wrong_or_unavailable_kernel_parent_never_establishes_ownership(self):
        tracker = self.retained_tracker()
        self.kernel_rows[101] = KernelIdentity(1001, 9999, 1, b"b" * 16)
        self.assertEqual(tracker.recover_after_exit(), [])
        self.assertEqual(tracker.helpers, {})
        self.assertFalse(tracker.report(1000)["passed"])
        tracker.recovery_attempted = False
        self.kernel_rows[101] = None
        self.assertEqual(tracker.recover_after_exit(), [])
        self.assertEqual(tracker.helpers, {})

    def test_kernel_identity_reuse_during_recovery_is_rejected(self):
        tracker = self.retained_tracker()
        original = self.kernel_rows[101]
        self.kernel.identity.side_effect = [original, KernelIdentity(9999, 1000, 1, b"b" * 16)]
        self.assertEqual(tracker.recover_after_exit(), [])
        self.assertEqual(tracker.helpers, {})

    def test_kernel_identity_change_after_recovery_invalidates_completion(self):
        tracker = self.retained_tracker()
        tracker.recover_after_exit()
        self.kernel_rows[101] = KernelIdentity(1001, 1000, 2, b"b" * 16)
        self.assertEqual(tracker.state((101, 2.0)), "invalid")
        self.assertFalse(tracker.report(1000)["passed"])

    def test_recovery_cannot_accept_foreign_executable_or_uid(self):
        tracker = self.retained_tracker()
        self.executable = self.main
        self.assertEqual(tracker.recover_after_exit(), [])
        tracker.recovery_attempted = False
        self.executable = self.helper
        self.proc.uids = lambda: SimpleNamespace(real=os.getuid() + 1)
        self.assertEqual(tracker.recover_after_exit(), [])
        self.assertEqual(tracker.helpers, {})

    def test_all_recovery_candidates_are_bounded_before_inspection(self):
        tracker = self.retained_tracker()
        self.kernel.same_uid_pids.return_value = list(range(1, MAX_PID_CANDIDATES + 2))
        self.kernel.identity.reset_mock()
        self.assertEqual(tracker.recover_after_exit(), [])
        self.assertTrue(tracker.invalid)
        self.kernel.identity.assert_not_called()

    def test_initial_root_birth_mismatch_fails_binding(self):
        prepared = CloneCleanup(self.app, self.helper, self.namespace)
        prepared.bind(SimpleNamespace(pid=100, create_time=lambda: 9.0))
        self.assertTrue(prepared.invalid)
        self.assertIsNone(prepared.root_pid)

    def test_completion_requires_exit_and_exact_clone_removal(self):
        self.qualify()
        self.parent = 1
        self.assertFalse(self.tracker.complete((101, 2.0)))
        del self.processes[101]
        self.assertFalse(self.tracker.complete((101, 2.0)))
        self.assertFalse(self.tracker.report(500)["passed"])
        shutil.rmtree(self.clone)
        self.assertTrue(self.tracker.complete((101, 2.0)))
        result = self.tracker.report(1000)
        self.assertTrue(result["passed"])
        self.assertTrue(result["qualified"])
        self.assertEqual(result["status"], "completed")
        self.assertNotIn(str(self.base), str(result))
        self.assertEqual(len(result["helpers"][0]["executableSha256"]), 64)

    def test_clone_removal_without_helper_exit_does_not_pass(self):
        self.qualify()
        shutil.rmtree(self.clone)
        self.assertFalse(self.tracker.complete((101, 2.0)))

    def test_role_string_without_observed_ancestry_cannot_qualify(self):
        self.parent = 1
        self.tracker.remember((101, 2.0), self.proc)
        self.assertEqual(self.tracker.helpers, {})

    def test_foreign_executable_cannot_qualify(self):
        self.executable = self.main
        self.tracker.remember((101, 2.0), self.proc)
        self.assertEqual(self.tracker.helpers, {})

    def test_reused_root_pid_cannot_establish_ancestry(self):
        self.processes[100] = SimpleNamespace(create_time=lambda: 9.0)
        self.tracker.remember((101, 2.0), self.proc)
        self.assertEqual(self.tracker.helpers, {})

    def test_reused_helper_pid_invalidates_completion(self):
        self.qualify()
        self.birth = 9.0
        self.assertEqual(self.tracker.state((101, 2.0)), "invalid")
        self.assertFalse(self.tracker.complete((101, 2.0)))

    def test_modified_helper_invalidates_existing_qualification(self):
        self.qualify()
        self.helper.write_bytes(b"substituted executable")
        self.assertEqual(self.tracker.state((101, 2.0)), "invalid")

    def test_prelaunch_helper_substitution_cannot_become_trusted(self):
        prepared = CloneCleanup(self.app, self.helper, self.namespace)
        self.helper.write_bytes(b"replaced before root binding")
        prepared.bind(self.root)
        self.assertTrue(prepared.invalid)
        self.assertIsNone(prepared.root_pid)

    def test_prelaunch_main_substitution_cannot_become_trusted(self):
        prepared = CloneCleanup(self.app, self.helper, self.namespace)
        self.main.write_bytes(b"replaced before root binding")
        prepared.bind(self.root)
        self.assertTrue(prepared.invalid)

    def test_window_grant_rehashes_content_even_with_matching_stat_fields(self):
        self.qualify()
        self.helper.write_bytes(b"replaced bytes")
        # Simulate matching/restored metadata, so only content verification can
        # reject this change. This is not an OS timestamp-resolution assumption.
        with patch("macos_clone_cleanup.file_stamp", return_value=self.tracker.helper_stamp):
            self.assertFalse(self.tracker.grant((101, 2.0)))
        self.assertTrue(self.tracker.invalid)

    def test_stale_process_object_does_not_establish_ancestry(self):
        stale = SimpleNamespace(create_time=lambda: 2.0)
        self.birth = 9.0
        self.tracker.remember((101, 2.0), stale)
        self.assertEqual(self.tracker.helpers, {})

    def test_live_foreign_uid_cannot_qualify(self):
        self.proc.uids = lambda: SimpleNamespace(real=os.getuid() + 1)
        self.tracker.remember((101, 2.0), self.proc)
        self.assertEqual(self.tracker.helpers, {})

    def test_arbitrary_or_duplicate_flags_cannot_qualify(self):
        self.args.append("--disable-sandbox")
        self.tracker.remember((101, 2.0), self.proc)
        self.assertEqual(self.tracker.helpers, {})

    def test_substituted_clone_directory_never_counts_as_removed(self):
        self.qualify()
        self.clone.rename(self.namespace / "old-owned-fixture")
        self.clone.mkdir(mode=0o700)
        del self.processes[101]
        self.assertIsNone(self.tracker.clone_removed("abc123"))
        self.assertFalse(self.tracker.report(1000)["passed"])

    def test_foreign_inode_or_symlink_never_establishes_clone_ownership(self):
        self.tracker.clones.clear()
        main = self.clone / (self.app.name + ".bundle") / "Contents/MacOS/bunly_host"
        main.unlink()
        main.write_bytes(self.main.read_bytes())
        self.tracker.discover_clones()
        self.assertEqual(self.tracker.clones, {})
        main.unlink()
        main.symlink_to(self.main)
        self.tracker.discover_clones()
        self.assertEqual(self.tracker.clones, {})

    def test_world_accessible_namespace_fails_closed(self):
        self.tracker.clones.clear()
        self.namespace.chmod(0o755)
        self.tracker.discover_clones()
        self.assertTrue(self.tracker.invalid)
        self.assertFalse(self.tracker.report(0)["passed"])

    def test_no_clone_observed_is_explicitly_not_qualification(self):
        self.tracker.clones.clear()
        result = self.tracker.report(0)
        self.assertTrue(result["passed"])
        self.assertFalse(result["qualified"])
        self.assertEqual(result["status"], "not-observed")

    def test_missing_or_substituted_namespace_does_not_prove_cleanup(self):
        self.qualify()
        self.namespace.rename(self.base / "moved-namespace")
        del self.processes[101]
        self.assertIsNone(self.tracker.clone_removed("abc123"))
        self.namespace.mkdir(mode=0o700)
        self.assertIsNone(self.tracker.clone_removed("abc123"))
        self.assertFalse(self.tracker.report(1000)["passed"])

    def test_clone_inventory_has_a_fixed_bound(self):
        self.tracker.clones.clear()
        for index in range(MAX_CLONES):
            (self.namespace / f"unrelated-{index}").touch()
        self.tracker.discover_clones()
        self.assertTrue(self.tracker.invalid)
        self.assertEqual(self.tracker.clones, {})

    def test_digest_rejects_links_and_oversized_executables(self):
        linked = self.base / "linked-helper"
        linked.symlink_to(self.helper)
        with self.assertRaises(ValueError):
            executable_digest(linked)
        with self.helper.open("wb") as output:
            output.truncate(64 * 1024**2 + 1)
        with self.assertRaises(ValueError):
            executable_digest(self.helper)


if __name__ == "__main__":
    unittest.main()

"""Attribution and accounting tests; mocks are not native process evidence."""

import os
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import macos_app_accounting as module


def fake_process(pid, name="fixture"):
    process = Mock()
    process.pid = pid
    process.info = {"pid": pid, "name": name, "uids": SimpleNamespace(real=501)}
    process.uids.return_value = SimpleNamespace(real=501)
    process.create_time.return_value = 10.0
    process.oneshot.side_effect = nullcontext
    process.cpu_times.return_value = SimpleNamespace(user=0.2, system=0.1)
    process.memory_info.return_value = SimpleNamespace(rss=100)
    process.num_threads.return_value = 2
    process.children.return_value = []
    process.exe.return_value = "/system-test/unused"
    return process


class BoundaryTests(unittest.TestCase):
    def test_self_responsible_separate_app_is_accepted(self):
        module.assert_boundary(10, 10, (20, 21), (30, 31))

    def test_shell_responsibility_never_becomes_app_identity(self):
        with self.assertRaisesRegex(module.AttributionError, "not-self-responsible"):
            module.assert_boundary(10, 99, (20, 21), (30, 31))

    def test_shared_either_coalition_is_rejected(self):
        for other in [(20, 31), (30, 21), (20, 21)]:
            with self.assertRaisesRegex(module.AttributionError, "shares-controller"):
                module.assert_boundary(10, 10, (20, 21), other)

    def test_native_errors_do_not_become_attribution(self):
        for invalid in [-1, 0, 999]:
            with self.assertRaises(module.AttributionError):
                module.assert_boundary(10, invalid, (20, 21), (30, 31))

    def test_service_requires_every_native_and_user_boundary(self):
        self.assertTrue(module.service_matches(10, (20, 21), 10, (20, 21), 501, 501, "gpu"))
        for resp, coalition, uid, role in [
            (11, (20, 21), 501, "gpu"),
            (10, (20, 22), 501, "gpu"),
            (10, (20, 21), 0, "gpu"),
            (10, (20, 21), 501, "same-name-but-not-WebKit"),
        ]:
            self.assertFalse(module.service_matches(10, (20, 21), resp, coalition, uid, 501, role))

    def test_paths_require_containment_and_exact_xpc_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            name = "com.apple.WebKit.WebContent"
            path = (
                root
                / "WebKit.framework"
                / "XPCServices"
                / (name + ".xpc")
                / "Contents"
                / "MacOS"
                / name
            )
            path.parent.mkdir(parents=True)
            path.write_text("test-only")
            self.assertEqual(module.webkit_role(path, root / "WebKit.framework"), "web-content")
            fake = root / name
            fake.write_text("same-name-outside-framework")
            self.assertIsNone(module.webkit_role(fake, root / "WebKit.framework"))
            wrong = root / "WebKit.framework" / name
            wrong.write_text("wrong-layout")
            self.assertIsNone(module.webkit_role(wrong, root / "WebKit.framework"))

    def test_symlink_escape_is_not_a_system_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "framework").mkdir()
            external = root / "com.apple.WebKit.GPU"
            external.write_text("test")
            (root / "framework" / "alias").symlink_to(external)
            self.assertIsNone(module.webkit_role(root / "framework" / "alias", root / "framework"))

    def test_invalid_sampling_options_rejected_before_pid_query(self):
        with patch.object(module, "verify") as verify:
            for seconds, interval in [(0, 0.1), (11, 0.1), (1, 0), (1, 0.01), (1, 1)]:
                with self.assertRaises(module.AttributionError):
                    module.collect(10, "unused", seconds, interval)
            verify.assert_not_called()


class GroupTests(unittest.TestCase):
    def invoke(self, responsible=100, role="web-content", same=True):
        root = fake_process(100)
        child = fake_process(101)
        web = fake_process(102, "com.apple.WebKit.WebContent")
        root.children.return_value = [child]
        native = Mock()
        native.responsible.side_effect = lambda pid: responsible if pid == 102 else 100
        native.coalition.side_effect = lambda pid: (3, 4) if pid == os.getpid() else (1, 2)
        with (
            patch.object(module, "verify", return_value=(root, 10.0)),
            patch.object(module.psutil, "process_iter", return_value=[web]),
            patch.object(module, "webkit_role", return_value=role),
            patch.object(module, "same_process", return_value=same),
            patch.object(
                module,
                "sample_counters",
                return_value={
                    "provider": "test",
                    "status": "unavailable",
                    "reason": "mock",
                    "counters": [],
                },
            ),
        ):
            result = module.sample_group(root, 10.0, "expected-private-exe", native)
        for proc in [root, child, web]:
            proc.kill.assert_not_called()
            proc.terminate.assert_not_called()
            proc.send_signal.assert_not_called()
        return result

    def test_webkit_service_is_separate_and_never_terminated(self):
        rows, unavailable, coalition = self.invoke()
        self.assertEqual([p["scope"] for p in rows], ["descendant", "descendant", "os-service"])
        self.assertEqual([p["pid"] for p in rows], [100, 101, 102])
        self.assertEqual(unavailable, 0)
        self.assertEqual(coalition, (1, 2))

    def test_other_application_service_is_not_counted(self):
        rows, _, _ = self.invoke(responsible=999)
        self.assertEqual([p["pid"] for p in rows], [100, 101])

    def test_same_responsibility_wrong_executable_fails_closed(self):
        with self.assertRaisesRegex(module.AttributionError, "inconsistent-associated"):
            self.invoke(role=None)

    def test_root_reuse_invalidates_measurement(self):
        with self.assertRaisesRegex(module.AttributionError, "identity-changed"):
            self.invoke(same=False)

    def test_simultaneous_totals_not_sum_of_per_process_peaks(self):
        def snapshot(ms, a, b, cpu):
            rows = [
                {
                    "pid": 1,
                    "creationTime": 1,
                    "scope": "descendant",
                    "role": "root",
                    "rssBytes": a,
                    "threads": 1,
                    "cpuSeconds": cpu,
                },
                {
                    "pid": 2,
                    "creationTime": 2,
                    "scope": "os-service",
                    "role": "gpu",
                    "rssBytes": b,
                    "threads": 1,
                    "cpuSeconds": cpu,
                },
            ]
            return {
                "elapsedMs": ms,
                "phase": "idle",
                "processes": rows,
                "rssBytes": a + b,
                "threads": 2,
            }

        report = module.reduce_samples([snapshot(0, 100, 10, 0), snapshot(1000, 10, 100, 0.1)])
        self.assertEqual(report["peakAttributedRssBytes"], 110)
        self.assertEqual(report["descendant"]["peakRssBytes"], 100)
        self.assertEqual(report["os-service"]["peakRssBytes"], 100)
        self.assertAlmostEqual(report["cpuPercentOneCore"], 20)
        self.assertNotIn("peakTreeRssBytes", report)

    def test_missing_samples_remain_unavailable(self):
        report = module.reduce_samples([])
        self.assertFalse(report["observed"])
        self.assertIsNone(report["peakAttributedRssBytes"])
        self.assertIsNone(report["cpuPercentOneCore"])


if __name__ == "__main__":
    unittest.main()

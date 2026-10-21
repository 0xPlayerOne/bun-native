"""Pinned diagnostic signatures; these unit tests are not native execution evidence."""

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import cef_process_role as roles


class ProcessRoleTests(unittest.TestCase):
    def test_explicit_helper_arguments(self):
        for role in ("renderer", "gpu-process"):
            self.assertEqual(roles.classify(["private-host", "--type=" + role])["role"], role)

    def test_main_and_zygote_broker_do_not_become_renderers(self):
        self.assertIsNone(roles.classify([]))
        self.assertIsNone(roles.classify(["--type=zygote"], ["bunly_host"]))
        self.assertIsNone(roles.classify(["--type=zygote"], ["Chrome_ChildIOT"]))

    def test_actual_observed_linux_renderer_signature(self):
        result = roles.classify(
            ["--type=zygote"], ["bunly_host", "Chrome_ChildIOT", "Compositor", "PerfettoTrace"]
        )
        self.assertEqual(result["role"], "renderer")
        self.assertEqual(result["argvRole"], "zygote")
        self.assertEqual(result["source"], "pinned-linux-zygote-thread-signature")

    def test_actual_observed_linux_gpu_signature(self):
        result = roles.classify(
            ["--type=zygote"], ["Chrome_ChildIOT", "GpuWatchdog", "VizCompositorTh", "llvmpipe-0"]
        )
        self.assertEqual(result["role"], "gpu-process")
        self.assertNotIn("llvmpipe-0", result["threadMarkers"])

    def test_partial_or_conflicting_signatures_are_unknown(self):
        for names in (
            ["Compositor"],
            ["Chrome_ChildIOT", "GpuWatchdog"],
            ["Chrome_ChildIOT", "VizCompositorTh"],
            ["Chrome_ChildIOT", "Compositor", "GpuWatchdog"],
            list(roles.MARKERS),
        ):
            self.assertIsNone(roles.classify(["--type=zygote"], names))

    def test_foreign_or_duplicate_argument_types_fail_closed(self):
        for args in (
            ["--type=utility"],
            ["--type=renderer", "--type=zygote"],
            ["--type=renderer", "--type=renderer"],
        ):
            self.assertIsNone(roles.classify(args, roles.MARKERS))

    def test_non_linux_never_uses_proc_signatures(self):
        process = Mock()
        process.cmdline.return_value = ["--type=zygote"]
        with patch.object(roles.sys, "platform", "win32"), patch.object(roles, "Path") as path:
            self.assertIsNone(roles.capture(process))
            path.assert_not_called()


if __name__ == "__main__":
    unittest.main()

"""Hosted orchestrator policy tests; these do not stand in for native execution."""

import json
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import hosted_cef as hosted


class HostedQualificationTests(unittest.TestCase):
    def test_only_declared_native_architectures(self):
        self.assertEqual(hosted.target("win32", "AMD64"), "win32-x64")
        self.assertEqual(hosted.target("linux", "x86_64"), "linux-x64")
        self.assertEqual(hosted.target("darwin", "arm64"), "darwin-arm64")
        for system, machine in [("win32", "arm64"), ("linux", "arm64"), ("darwin", "x86_64")]:
            with self.assertRaises(ValueError):
                hosted.target(system, machine)

    def test_suite_keeps_exact_native_commands_and_standard_deadlines(self):
        smoke = hosted.commands("smoke", "/bun", Path("/app"))
        full = hosted.commands("full", "/bun", Path("/app"))
        self.assertEqual([name for name, _ in smoke], ["prebuilt"])
        self.assertEqual(
            [name for name, _ in full],
            ["prebuilt", "development", "network", "transports", "faults"],
        )
        self.assertTrue(
            all(
                "--emulated-functional" not in args and "--no-sandbox" not in args
                for _, args in full
            )
        )
        self.assertEqual(full[-1][1][-2:], ["--bun", "/bun"])
        with self.assertRaises(ValueError):
            hosted.commands("arbitrary-shell", "/bun", Path("/app"))

    def test_rpc_suite_requires_real_native_rpc_evidence_without_weaker_deadlines(self):
        # Preserve native path formatting instead of assuming a Unix literal.
        # Pure paths exercise both platforms even on a single contributor OS.
        for root, app, bun in (
            (PurePosixPath("/repo"), PurePosixPath("/app"), "/bun"),
            (PureWindowsPath("C:/repo"), PureWindowsPath("C:/app.exe"), "C:/bun.exe"),
        ):
            with self.subTest(path_type=type(app).__name__), patch.object(hosted, "ROOT", root):
                commands = hosted.commands("rpc", bun, app)
                self.assertEqual(
                    [name for name, _ in commands],
                    ["prebuilt", "development", "network", "transports"],
                )
                self.assertEqual(
                    commands[1][1],
                    [bun, str(root / "scripts/qualify-cef-development.ts"), str(app)],
                )
                self.assertEqual(
                    commands[0][1], [bun, str(root / "scripts/qualify-cef-rpc.ts"), str(app)]
                )
                self.assertEqual(
                    commands[2][1], [bun, str(root / "scripts/qualify-cef-network.ts"), str(app)]
                )
                self.assertEqual(
                    commands[3][1],
                    [
                        bun,
                        str(root / "scripts/qualify-cef-transports.ts"),
                        str(app),
                        "--functional",
                    ],
                )
                self.assertNotIn("--emulated-functional", commands[0][1])
                self.assertNotIn("--no-sandbox", commands[0][1])

    def test_credential_suite_is_explicit_and_does_not_replace_ordinary_rpc(self):
        for root, app, bun in (
            (PurePosixPath("/repo"), PurePosixPath("/app"), "/bun"),
            (PureWindowsPath("C:/repo"), PureWindowsPath("C:/app.exe"), "C:/bun.exe"),
        ):
            with self.subTest(path_type=type(app).__name__), patch.object(hosted, "ROOT", root):
                self.assertEqual(
                    hosted.commands("credentials", bun, app),
                    [
                        (
                            "credentials",
                            [bun, str(root / "scripts/qualify-cef-credentials.ts"), str(app)],
                        )
                    ],
                )
                self.assertNotIn(
                    "credentials", [name for name, _ in hosted.commands("rpc", bun, app)]
                )

    def test_stale_or_duplicate_reports_never_pass(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(hosted, "ROOT", Path(directory)),
        ):
            first = Path(directory) / ".bunly/m3/prebuilt/run-one/report.json"
            first.parent.mkdir(parents=True)
            first.write_text(json.dumps({"passed": True}))
            self.assertEqual(hosted.new_report("prebuilt", set()), {"passed": True})
            with self.assertRaises(ValueError):
                hosted.new_report("prebuilt", {first})
            second = first.parent.parent / "run-two/report.json"
            second.parent.mkdir()
            second.write_text("{}")
            with self.assertRaises(ValueError):
                hosted.new_report("prebuilt", set())

    def test_refuses_admin_before_launching_native_processes(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(hosted, "EVIDENCE", Path(directory)),
            patch.object(hosted, "standard_user", return_value=False),
            patch.object(hosted, "target", return_value="win32-x64"),
            patch.object(hosted, "execute") as execute,
        ):
            self.assertEqual(hosted.run("full"), 1)
            execute.assert_not_called()
            result = json.loads((Path(directory) / "qualification.json").read_text())
            self.assertFalse(result["passed"])
            self.assertIn("administrator", result["failure"])

    def test_collection_excludes_private_trees_and_redacts_fixture_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / ".bunly/hosted-evidence"
            report = root / ".bunly/m3/faults/run-one/report.json"
            report.parent.mkdir(parents=True)
            report.write_text(json.dumps({"passed": False, "nonce": "a" * 48, "sha256": "b" * 64}))
            (report.parent / "credentials.json").write_text('{"private":"not-for-upload"}')
            with (
                patch.object(hosted, "ROOT", root),
                patch.object(hosted, "EVIDENCE", evidence),
                patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}),
            ):
                hosted.collect()
            self.assertEqual(len(list(evidence.iterdir())), 1)
            text = next(evidence.iterdir()).read_text()
            self.assertIn("[fixture-nonce]", text)
            self.assertIn("b" * 64, text)
            self.assertNotIn("not-for-upload", text)


if __name__ == "__main__":
    unittest.main()

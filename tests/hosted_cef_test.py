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
            [
                "prebuilt",
                "development",
                "network",
                "transports",
                "session-reset",
                "faults",
                "terminals",
                "credentials",
            ],
        )
        self.assertTrue(
            all(
                "--emulated-functional" not in args and "--no-sandbox" not in args
                for _, args in full
            )
        )
        self.assertEqual(dict(full)["faults"][-2:], ["--bun", "/bun"])
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
                    ["prebuilt", "development", "network", "transports", "session-reset"],
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
                self.assertEqual(
                    commands[4][1],
                    [bun, str(root / "scripts/qualify-cef-session-reset.ts"), str(app)],
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

    def test_m4_acceptance_is_one_exact_portable_suite_definition(self):
        for root, app, bun in (
            (PurePosixPath("/repo"), PurePosixPath("/app"), "/bun"),
            (PureWindowsPath("C:/repo"), PureWindowsPath("C:/app.exe"), "C:/bun.exe"),
        ):
            with self.subTest(path_type=type(app).__name__), patch.object(hosted, "ROOT", root):
                m4 = hosted.commands("m4-acceptance", bun, app)
                self.assertEqual(
                    m4, hosted.commands("rpc", bun, app) + hosted.commands("credentials", bun, app)
                )
                self.assertEqual(
                    [
                        row
                        for row in hosted.commands("full", bun, app)
                        if row[0] not in ("faults", "terminals")
                    ],
                    m4,
                )
                self.assertEqual(len({name for name, _ in m4}), 6)
                self.assertTrue(m4[0][1][1].endswith("qualify-cef-rpc.ts"))
                self.assertEqual(m4[-1][0], "credentials")

    def test_automatic_and_manual_workflows_use_full_with_faults_before_providers(self):
        workflow = (hosted.ROOT / ".github/workflows/cef-runtime.yml").read_text()
        self.assertIn("options: [portable, smoke, full, m4-acceptance]", workflow)
        self.assertIn("run --suite full", workflow)
        self.assertIn("-Suite full", workflow)
        self.assertNotIn("run --suite rpc", workflow)
        windows = (hosted.ROOT / "scripts/hosted-windows.ps1").read_text()
        self.assertIn("'m4-acceptance'", windows)

    def test_provider_stage_cannot_run_after_failed_or_incomplete_ordinary_acceptance(self):
        rows = [
            {"name": name, "passed": True} for name, _ in hosted.commands("rpc", "bun", Path("app"))
        ]
        hosted.require_stage_prerequisites("m4-acceptance", "credentials", rows)
        hosted.require_stage_prerequisites("credentials", "credentials", [])
        for invalid in ([], rows[:-1], list(reversed(rows)), [*rows, rows[0]]):
            with self.assertRaises(ValueError):
                hosted.require_stage_prerequisites("m4-acceptance", "credentials", invalid)
        for index in range(len(rows)):
            failed = [dict(row) for row in rows]
            failed[index]["passed"] = False
            with self.assertRaises(ValueError):
                hosted.require_stage_prerequisites("full", "credentials", failed)

    def test_provider_packages_are_delayed_and_forbidden_on_a_workstation(self):
        workflow = (hosted.ROOT / ".github/workflows/cef-runtime.yml").read_text()
        self.assertNotIn("apt-get install -y gnome-keyring", workflow)
        for platform in ("darwin", "win32"):
            with (
                patch.object(hosted.sys, "platform", platform),
                patch.object(hosted.subprocess, "run") as run,
            ):
                hosted.prepare_credential_prerequisites()
                run.assert_not_called()
        with (
            patch.object(hosted.sys, "platform", "linux"),
            patch.object(hosted, "standard_user", return_value=True),
            patch.dict("os.environ", {"GITHUB_ACTIONS": "false", "RUNNER_ENVIRONMENT": "local"}),
            patch.object(hosted.subprocess, "run") as run,
        ):
            with self.assertRaises(ValueError):
                hosted.prepare_credential_prerequisites()
            run.assert_not_called()
        with (
            patch.object(hosted.sys, "platform", "linux"),
            patch.object(hosted, "standard_user", return_value=True),
            patch.dict(
                "os.environ", {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"}
            ),
            patch.object(hosted.subprocess, "run") as run,
        ):
            hosted.prepare_credential_prerequisites()
            run.assert_called_once_with(
                [
                    "sudo",
                    "apt-get",
                    "install",
                    "-y",
                    "gnome-keyring",
                    "libsecret-tools",
                    "libglib2.0-bin",
                ],
                check=True,
                timeout=180,
            )

    def test_full_runs_every_ordinary_fault_case_before_provider_provisioning(self):
        names = [name for name, _ in hosted.commands("full", "bun", Path("app"))]
        self.assertEqual(names[-1], "credentials")
        self.assertLess(names.index("faults"), names.index("credentials"))
        rows = [{"name": name, "passed": True} for name in names[:-1]]
        hosted.require_stage_prerequisites("full", "credentials", rows)
        rows[-1]["passed"] = False
        with self.assertRaises(ValueError):
            hosted.require_stage_prerequisites("full", "credentials", rows)

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


class EvidenceExportTests(unittest.TestCase):
    def test_explicit_export_is_idempotent_and_keeps_failure_accounting(self):
        from export_native_evidence import sanitize_report

        raw = {
            "observation": {"schema": 1, "exitCode": 2, "samples": [], "observationId": "a" * 48}
        }
        exported = sanitize_report(raw)
        self.assertEqual(exported["observation"]["exitCode"], 2)
        self.assertNotIn("observationId", exported["observation"])
        self.assertIn("observationId", raw["observation"])
        self.assertEqual(sanitize_report(exported), exported)
        raw["observation"]["observationId"] = "malformed"
        with self.assertRaises(ValueError):
            sanitize_report(raw)


if __name__ == "__main__":
    unittest.main()


class GraphicalTerminalStageTests(unittest.TestCase):
    def test_full_runs_graphical_terminals_before_providers_and_uses_its_report_family(self):
        # Keep the fixture portable: Path renders the native separator on
        # Windows. Compare the exact supplied path, not a Unix-only spelling.
        app = Path("/app")
        commands = hosted.commands("full", "/bun", app)
        names = [name for name, _ in commands]
        self.assertEqual(names[-2:], ["terminals", "credentials"])
        self.assertEqual(
            dict(commands)["terminals"],
            [
                "/bun",
                str(hosted.ROOT / "scripts/qualify-cef-terminals.ts"),
                str(app),
                "--functional",
            ],
        )
        self.assertEqual(
            hosted.report_directory("terminals"), hosted.ROOT / ".bunly/m5/graphical-terminals"
        )
        self.assertEqual(hosted.report_directory("network"), hosted.ROOT / ".bunly/m3/network")
        rows = [{"name": name, "passed": True} for name in names[:-1]]
        hosted.require_stage_prerequisites("full", "credentials", rows)
        rows[-1]["passed"] = False
        with self.assertRaises(ValueError):
            hosted.require_stage_prerequisites("full", "credentials", rows)

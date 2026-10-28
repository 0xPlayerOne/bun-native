"""Hosted orchestrator policy tests; these do not stand in for native execution."""

import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import hosted_cef as hosted


def cp1252_text_default():
    """Use real file decoding with Windows' non-UTF-8 default on every test OS."""
    read_text = Path.read_text

    def read(path, encoding=None, errors=None):
        return read_text(path, encoding=encoding or "cp1252", errors=errors)

    return patch.object(Path, "read_text", read)


class HostedQualificationTests(unittest.TestCase):
    def test_build_account_cli_handoff_is_ascii_even_with_windows_legacy_stdout(self):
        selected = str(PureWindowsPath("C:/selected é Ω")) + chr(92)
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=newline):
                data = io.BytesIO()
                output = io.TextIOWrapper(
                    data, encoding="cp1252", newline=newline, write_through=True
                )
                with (
                    patch.dict(hosted.os.environ, {"GITHUB_ACTIONS": "true"}),
                    patch.object(hosted.shutil, "which", return_value="/build-account/bun"),
                    patch.object(hosted, "native_target_directory", return_value=selected) as query,
                    patch.object(hosted.sys, "stdout", output),
                ):
                    hosted.main(["target-directory-base64"])
                query.assert_called_once_with("/build-account/bun")
                # PowerShell captures one native-output line without its OS newline.
                # Model both encodings of that boundary on every test platform.
                lines = data.getvalue().splitlines()
                self.assertEqual(len(lines), 1)
                encoded = lines[0]
                self.assertTrue(encoded.isascii())
                self.assertEqual(base64.b64decode(encoded, validate=True).decode("utf-8"), selected)
                output.detach()

    def test_worker_uses_the_exact_build_account_handoff_without_a_compiler(self):
        with tempfile.TemporaryDirectory() as directory:
            selected = str(Path(directory) / "Unicode é Ω ")
            with (
                patch.dict(hosted.os.environ, {"PATH": "", "HOME": directory}, clear=True),
                patch.object(hosted.subprocess, "run") as run,
            ):
                self.assertEqual(
                    hosted.native_target_directory("/missing-bun", selected), Path(selected)
                )
                run.assert_not_called()
                for invalid in [
                    "",
                    "relative/target",
                    selected + "\n",
                    selected + "\r",
                    selected + "\0",
                ]:
                    with self.subTest(value=invalid), self.assertRaises(ValueError):
                        hosted.native_target_directory("/missing-bun", invalid)
                run.assert_not_called()

    def test_terminal_fixture_uses_the_queried_cargo_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            selected = str(Path(directory) / "Unicode é Ω ")
            with patch.object(hosted.subprocess, "run") as run:
                run.return_value.stdout = selected + "\n"
                self.assertEqual(hosted.native_target_directory("/bun"), Path(selected))
                run.assert_called_once_with(
                    [
                        "/bun",
                        str(hosted.ROOT / "scripts/cargo.ts"),
                        "--print-target-dir",
                        "--manifest-path",
                        str(hosted.ROOT / "native/cef-host/Cargo.toml"),
                    ],
                    cwd=hosted.ROOT,
                    env={
                        **os.environ,
                        "RUSTUP_TOOLCHAIN": os.environ.get("RUSTUP_TOOLCHAIN", "1.91.0"),
                    },
                    check=True,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=15,
                )
            for value in [
                "",
                "target/release",
                directory + "\nextra-output",
                directory + "\n\n",
                directory + "\rextra-output",
            ]:
                with self.subTest(value=value), patch.object(hosted.subprocess, "run") as run:
                    run.return_value.stdout = value
                    with self.assertRaises(ValueError):
                        hosted.native_target_directory("/bun")

    def test_native_query_uses_installed_cef_toolchain_without_changing_target_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            selected = str(Path(directory) / "selected-target")
            environment = {
                "PATH": "/tools",
                "CI": "true",
                "CARGO_TARGET_DIR": selected,
                "BUNLY_SHARED_CACHE_DIR": str(Path(directory) / "shared-cache"),
                "CEF_PATH": str(Path(directory) / "cef-sdk"),
            }
            with (
                patch.dict(hosted.os.environ, environment, clear=True),
                patch.object(hosted.subprocess, "run") as run,
            ):
                run.return_value.stdout = selected + "\n"
                self.assertEqual(hosted.native_target_directory("/bun"), Path(selected))
                self.assertEqual(
                    run.call_args.kwargs["env"],
                    {**environment, "RUSTUP_TOOLCHAIN": "1.91.0"},
                )
                self.assertNotIn("RUSTUP_TOOLCHAIN", hosted.os.environ)

    def test_native_query_preserves_explicit_contributor_toolchain(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(hosted.os.environ, {"RUSTUP_TOOLCHAIN": "custom-cef"}, clear=True),
            patch.object(hosted.subprocess, "run") as run,
        ):
            run.return_value.stdout = directory + "\n"
            self.assertEqual(hosted.native_target_directory("/bun"), Path(directory))
            self.assertEqual(run.call_args.kwargs["env"], {"RUSTUP_TOOLCHAIN": "custom-cef"})

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
                "desktop",
                "view-composition",
                "desktop-services",
                "file-downloads",
                "window-modes",
                "terminals",
                "terminal-load",
                "managed-development",
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
                        if row[0]
                        not in (
                            "faults",
                            "desktop",
                            "view-composition",
                            "desktop-services",
                            "file-downloads",
                            "window-modes",
                            "terminals",
                            "terminal-load",
                            "managed-development",
                        )
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

    def test_bundle_path_uses_utf8_under_a_non_utf8_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / ".bunly/cef-bundle"
            bundle.mkdir(parents=True)
            app = bundle / "native-café-🐙.exe"
            app.write_bytes(b"selected fixture")
            (bundle / "bundle.json").write_bytes(
                json.dumps({"path": str(app)}, ensure_ascii=False).encode("utf-8")
            )
            with patch.object(hosted, "ROOT", root), cp1252_text_default():
                self.assertEqual(hosted.artifact(), app.resolve(strict=True))

    def test_collection_preserves_utf8_failures_under_a_non_utf8_default(self):
        # The accent silently became mojibake in older exports; the octopus adds
        # byte 0x90, which the same CP1252 default cannot decode at all.
        for message in ("café", "café-🐙"):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                evidence = root / ".bunly/hosted-evidence"
                evidence.mkdir(parents=True)
                report = root / ".bunly/m6/managed-development/run-one/report.json"
                report.parent.mkdir(parents=True)
                value = {"passed": False, "failure": message, "path": "nested/unicode-é.txt"}
                raw = (json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8")
                report.write_bytes(raw)
                canonical = evidence / "managed-development.json"
                canonical.write_bytes(raw)
                (evidence / "qualification.json").write_bytes(raw)
                log = evidence / "managed-development.log"
                log.write_bytes(("failure: " + message + "\n").encode("utf-8"))
                summary = root / "summary.md"
                with (
                    patch.object(hosted, "ROOT", root),
                    patch.object(hosted, "EVIDENCE", evidence),
                    patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": str(summary)}),
                    cp1252_text_default(),
                ):
                    hosted.collect()
                exported = json.loads(canonical.read_text(encoding="utf-8"))
                collected = json.loads(
                    (evidence / "managed-development-run-one.json").read_text(encoding="utf-8")
                )
                self.assertEqual(exported, collected)
                self.assertFalse(collected["passed"])
                self.assertEqual(collected["failure"], message)
                self.assertEqual(collected["path"], value["path"])
                self.assertEqual(report.read_bytes(), raw)
                self.assertEqual(log.read_text(encoding="utf-8"), "failure: " + message + "\n")
                summary_json = summary.read_text(encoding="utf-8").split("```json\n")[1]
                self.assertEqual(json.loads(summary_json.split("```", 1)[0]), exported)

    def test_collection_rejects_invalid_utf8_without_rewriting_evidence(self):
        for location in (
            ".bunly/m6/managed-development/run-one/report.json",
            ".bunly/hosted-evidence/managed-development.json",
            ".bunly/hosted-evidence/managed-development.log",
        ):
            with self.subTest(location=location), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / location
                path.parent.mkdir(parents=True)
                original = b'{"passed":false,"failure":"invalid byte: \xff"}\n'
                path.write_bytes(original)
                with (
                    patch.object(hosted, "ROOT", root),
                    patch.object(hosted, "EVIDENCE", root / ".bunly/hosted-evidence"),
                    patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}),
                    cp1252_text_default(),
                    self.assertRaises(UnicodeDecodeError),
                ):
                    hosted.collect()
                self.assertEqual(path.read_bytes(), original)


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
        self.assertEqual(
            names[-4:], ["terminals", "terminal-load", "managed-development", "credentials"]
        )
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


class NativeWindowStageTests(unittest.TestCase):
    def test_full_uses_native_modes_with_disposable_linux_wm_and_preserves_provider_gate(self):
        app = Path("/app")
        for system in ("linux", "darwin", "win32"):
            with self.subTest(system=system), patch.object(hosted.sys, "platform", system):
                selected = hosted.commands("full", "/bun", app)
                names = [name for name, _ in selected]
                self.assertEqual(
                    names[-5:],
                    [
                        "window-modes",
                        "terminals",
                        "terminal-load",
                        "managed-development",
                        "credentials",
                    ],
                )
                expected = (
                    [
                        sys.executable,
                        str(hosted.ROOT / "scripts/qualify-cef-window-modes-linux.py"),
                        "--disposable-runner",
                        "--bun",
                        "/bun",
                        str(app),
                    ]
                    if system == "linux"
                    else [
                        "/bun",
                        str(hosted.ROOT / "scripts/qualify-cef-window-modes.ts"),
                        str(app),
                    ]
                )
                self.assertEqual(dict(selected)["window-modes"], expected)
                self.assertNotIn(
                    "window-modes", dict(hosted.commands("m4-acceptance", "/bun", app))
                )
                rows = [{"name": name, "passed": True} for name in names[:-1]]
                hosted.require_stage_prerequisites("full", "credentials", rows)
                next(row for row in rows if row["name"] == "window-modes")["passed"] = False
                with self.assertRaises(ValueError):
                    hosted.require_stage_prerequisites("full", "credentials", rows)
        self.assertEqual(
            hosted.report_directory("window-modes"), hosted.ROOT / ".bunly/m5/window-modes"
        )
        workflow = (hosted.ROOT / ".github/workflows/cef-runtime.yml").read_text()
        self.assertEqual(workflow.count("libgbm1 xvfb dbus-x11 openbox"), 2)


class NativeTerminalLoadStageTests(unittest.TestCase):
    def test_explicit_window_load_is_required_before_credentials_on_every_platform(self):
        app = Path("/app")
        for system in ("linux", "darwin", "win32"):
            with self.subTest(system=system), patch.object(hosted.sys, "platform", system):
                selected = hosted.commands("full", "/bun", app)
                names = [name for name, _ in selected]
                self.assertEqual(len(names), 15)
                self.assertEqual(
                    names[-4:], ["terminals", "terminal-load", "managed-development", "credentials"]
                )
                expected = (
                    [
                        sys.executable,
                        str(hosted.ROOT / "scripts/qualify-cef-window-modes-linux.py"),
                        "--disposable-runner",
                        "--terminal-load",
                        "--bun",
                        "/bun",
                        str(app),
                    ]
                    if system == "linux"
                    else [
                        "/bun",
                        str(hosted.ROOT / "scripts/qualify-terminal-window-load.ts"),
                        "cef",
                        str(app),
                        "--functional",
                    ]
                )
                self.assertEqual(dict(selected)["terminal-load"], expected)
                rows = [{"name": name, "passed": True} for name in names[:-1]]
                hosted.require_stage_prerequisites("full", "credentials", rows)
                rows[-1]["passed"] = False
                with self.assertRaises(ValueError):
                    hosted.require_stage_prerequisites("full", "credentials", rows)
                self.assertNotIn(
                    "terminal-load", dict(hosted.commands("m4-acceptance", "/bun", app))
                )
        self.assertEqual(
            hosted.report_directory("terminal-load"), hosted.ROOT / ".bunly/m5/terminal-load"
        )


class ManagedDevelopmentStageTests(unittest.TestCase):
    def test_full_requires_exact_source_and_fresh_managed_report_before_credentials(self):
        source = "a" * 40
        for root, app, bun in (
            (PurePosixPath("/repo"), PurePosixPath("/app"), "/bun"),
            (PureWindowsPath("C:/repo"), PureWindowsPath("C:/app.exe"), "C:/bun.exe"),
        ):
            with self.subTest(path_type=type(app).__name__), patch.object(hosted, "ROOT", root):
                selected = hosted.commands("full", bun, app, native_source=source)
                self.assertEqual(
                    dict(selected)["managed-development"],
                    [
                        bun,
                        str(root / "scripts/qualify-managed-development.ts"),
                        str(app),
                        "--native-source=" + source,
                    ],
                )
                self.assertEqual(
                    hosted.report_directory("managed-development"),
                    root / ".bunly/m6/managed-development",
                )
                rows = [{"name": name, "passed": True} for name, _ in selected[:-1]]
                hosted.require_stage_prerequisites("full", "credentials", rows)
                rows[-1]["passed"] = False
                with self.assertRaises(ValueError):
                    hosted.require_stage_prerequisites("full", "credentials", rows)
                self.assertNotIn(
                    "managed-development", dict(hosted.commands("m4-acceptance", bun, app))
                )
                for invalid in ("HEAD", "main", source + "0", "--no-sandbox"):
                    with self.assertRaises(ValueError):
                        hosted.commands("full", bun, app, native_source=invalid)


class DesktopStageTests(unittest.TestCase):
    def test_downloads_requires_exact_source_and_settlement_before_providers(self):
        source = "a" * 40
        app = Path("/app")
        for system in ("linux", "darwin", "win32"):
            with self.subTest(system=system), patch.object(hosted.sys, "platform", system):
                selected = hosted.commands("full", "/bun", app, native_source=source)
                names = [name for name, _ in selected]
                self.assertEqual(names.count("file-downloads"), 1)
                self.assertEqual(names.index("file-downloads"), names.index("desktop-services") + 1)
                self.assertEqual(
                    dict(selected)["file-downloads"],
                    [
                        *dict(selected)["desktop"],
                        "--desktop-case=downloads" if system == "linux" else "--case=downloads",
                    ],
                )
                self.assertNotIn("--disposable-clipboard", dict(selected)["file-downloads"])
                rows = [{"name": name, "passed": True} for name in names[:-1]]
                hosted.require_stage_prerequisites("full", "credentials", rows)
                next(row for row in rows if row["name"] == "file-downloads")["passed"] = False
                with self.assertRaises(ValueError):
                    hosted.require_stage_prerequisites("full", "credentials", rows)
                self.assertNotIn(
                    "file-downloads", dict(hosted.commands("m4-acceptance", "/bun", app))
                )
        self.assertEqual(
            hosted.report_directory("file-downloads"), hosted.ROOT / ".bunly/m7/file-downloads"
        )

    def test_services_requires_disposable_clipboard_opt_in_only_on_supported_platforms(self):
        source = "a" * 40
        app = Path("/app")
        for system in ("linux", "darwin", "win32"):
            with self.subTest(system=system), patch.object(hosted.sys, "platform", system):
                selected = hosted.commands("full", "/bun", app, native_source=source)
                names = [name for name, _ in selected]
                self.assertEqual(names.count("desktop-services"), 1)
                self.assertEqual(
                    names.index("desktop-services"), names.index("view-composition") + 1
                )
                expected = [
                    *dict(selected)["desktop"],
                    "--desktop-case=services" if system == "linux" else "--case=services",
                ]
                if system != "linux":
                    expected.append("--disposable-clipboard")
                self.assertEqual(dict(selected)["desktop-services"], expected)
                rows = [{"name": name, "passed": True} for name in names[:-1]]
                hosted.require_stage_prerequisites("full", "credentials", rows)
                next(row for row in rows if row["name"] == "desktop-services")["passed"] = False
                with self.assertRaises(ValueError):
                    hosted.require_stage_prerequisites("full", "credentials", rows)
                self.assertNotIn(
                    "desktop-services", dict(hosted.commands("m4-acceptance", "/bun", app))
                )
        self.assertEqual(
            hosted.report_directory("desktop-services"), hosted.ROOT / ".bunly/m7/desktop-services"
        )

    def test_composition_requires_its_own_report_and_every_platform_before_providers(self):
        source = "a" * 40
        app = Path("/app")
        for system in ("linux", "darwin", "win32"):
            with self.subTest(system=system), patch.object(hosted.sys, "platform", system):
                selected = hosted.commands("full", "/bun", app, native_source=source)
                names = [name for name, _ in selected]
                self.assertEqual(names.count("view-composition"), 1)
                self.assertEqual(names.index("view-composition"), names.index("desktop") + 1)
                self.assertEqual(
                    dict(selected)["view-composition"],
                    [
                        *dict(selected)["desktop"],
                        "--desktop-case=composition" if system == "linux" else "--case=composition",
                    ],
                )
                rows = [{"name": name, "passed": True} for name in names[:-1]]
                hosted.require_stage_prerequisites("full", "credentials", rows)
                next(row for row in rows if row["name"] == "view-composition")["passed"] = False
                with self.assertRaises(ValueError):
                    hosted.require_stage_prerequisites("full", "credentials", rows)
                self.assertNotIn(
                    "view-composition", dict(hosted.commands("m4-acceptance", "/bun", app))
                )
        self.assertEqual(
            hosted.report_directory("view-composition"), hosted.ROOT / ".bunly/m7/view-composition"
        )

    def test_native_desktop_requires_exact_source_and_gates_providers_on_every_platform(self):
        source = "a" * 40
        app = Path("/app")
        for system in ("linux", "darwin", "win32"):
            with self.subTest(system=system), patch.object(hosted.sys, "platform", system):
                selected = hosted.commands("full", "/bun", app, native_source=source)
                names = [name for name, _ in selected]
                self.assertEqual(names.count("desktop"), 1)
                self.assertLess(names.index("desktop"), names.index("credentials"))
                expected = (
                    [
                        sys.executable,
                        str(hosted.ROOT / "scripts/qualify-cef-window-modes-linux.py"),
                        "--disposable-runner",
                        "--desktop",
                        "--bun",
                        "/bun",
                        str(app),
                    ]
                    if system == "linux"
                    else ["/bun", str(hosted.ROOT / "scripts/qualify-desktop.ts"), str(app)]
                )
                self.assertEqual(
                    dict(selected)["desktop"], [*expected, "--native-source=" + source]
                )
                rows = [{"name": name, "passed": True} for name in names[:-1]]
                hosted.require_stage_prerequisites("full", "credentials", rows)
                next(row for row in rows if row["name"] == "desktop")["passed"] = False
                with self.assertRaises(ValueError):
                    hosted.require_stage_prerequisites("full", "credentials", rows)
                self.assertNotIn("desktop", dict(hosted.commands("m4-acceptance", "/bun", app)))
        self.assertEqual(hosted.report_directory("desktop"), hosted.ROOT / ".bunly/m7/desktop")

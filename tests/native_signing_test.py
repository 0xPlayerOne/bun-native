"""Native command plans/parsers and actual failure/receipt I/O, not native OS proof."""

import copy
import hashlib
import importlib.util
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/native_signing.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("native_signing", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def mac():
    return {
        "schema": 1,
        "platform": "darwin",
        "artifact": "build/Test App.app",
        "certificateSha1": "A" * 40,
        "teamId": "ABCDE12345",
        "bundleIdentifier": "dev.bunly.test",
        "targets": [
            {"path": "build/Test App.app/Contents/Frameworks/helper.dylib"},
            {"path": "build/Test App.app"},
        ],
    }


def windows():
    return {
        "schema": 1,
        "platform": "win32",
        "artifact": "build/app",
        "certificateSha1": "B" * 40,
        "signtool": {"path": "C:\\SDK\\bin\\signtool.exe", "sha256": "c" * 64},
        "timestampUrl": "https://timestamp.example.test/rfc3161",
        "targets": [{"path": "build/app/main.exe"}],
    }


def plan():
    task = {
        "dependsOn": [],
        "commands": [["bun", "build"]],
        "verify": ["bun", "verify"],
        "timeoutMs": 5000,
        "outputs": [
            {"category": "installed", "kind": "directory", "path": mac()["artifact"], "fresh": True}
        ],
    }
    return {
        "schema": 1,
        "framework": "explicit-test",
        "version": "1",
        "sourceCommit": "a" * 40,
        "tasks": {
            "app-assembly": task,
            "installer-compress": {**task, "dependsOn": ["app-assembly"], "outputs": []},
        },
        "unsupported": {
            s: "not in fixture" for s in m.STAGES - {"app-assembly", "installer-compress"}
        },
    }


class SigningTests(unittest.TestCase):
    def test_policies_are_explicit_and_copied(self):
        for policy in (mac(), windows()):
            output = m.validate_policy(policy)
            self.assertEqual(output, policy)
            self.assertIsNot(output["targets"], policy["targets"])
        for alteration in (
            {"schema": True},
            {"certificateSha1": "-"},
            {"privateKey": "forbidden"},
            {"platform": "linux"},
            {"targets": []},
        ):
            with self.assertRaises(m.SigningError):
                m.validate_policy({**mac(), **alteration})

    def test_paths_and_nested_order(self):
        for path in (
            "../app",
            "C:/app",
            "app\\file",
            "app//x",
            "app/CON",
            "app/file.",
            "app/../a",
            "/app",
            "app/\\0",
        ):
            with self.assertRaises(m.SigningError, msg=path):
                m.relative_name(path)
        for targets in (
            list(reversed(mac()["targets"])),
            mac()["targets"] * 2,
            [{"path": "outside.app"}],
            [
                {"path": "build/Test App.app/FILE"},
                {"path": "build/Test App.app/file"},
                mac()["targets"][-1],
            ],
        ):
            with self.assertRaises(m.SigningError):
                m.validate_policy({**mac(), "targets": targets})

    def test_entitlements_require_pinned_public_plists(self):
        p = mac()
        p["targets"][-1]["entitlements"] = {"path": "entitlements.plist", "sha256": "f" * 64}
        m.validate_policy(p)
        p["targets"][-1]["entitlements"]["path"] = p["artifact"] + "/entitlements.plist"
        with self.assertRaises(m.SigningError):
            m.validate_policy(p)
        p = windows()
        p["targets"][0]["entitlements"] = {"path": "a", "sha256": "f" * 64}
        with self.assertRaises(m.SigningError):
            m.validate_policy(p)

    def test_windows_timestamp_and_tool_pin(self):
        for timestamp in (
            "http://tsa.test",
            "https://u:p@tsa.test",
            "https://tsa.test/?key=secret",
            "file:///x",
        ):
            with self.assertRaises(m.SigningError):
                m.validate_policy({**windows(), "timestampUrl": timestamp})
        for path in ("signtool.exe", "C:/SDK/not-signtool.exe", "C:/SDK/tool.ps1"):
            with self.assertRaises(m.SigningError):
                m.validate_policy({**windows(), "signtool": {"path": path, "sha256": "f" * 64}})

    def test_native_commands_do_not_bypass_security_or_select_first_identity(self):
        args = m.mac_sign_command(mac(), mac()["targets"][-1], "/tmp/Test App.app", "/tmp")
        self.assertEqual(args[0], "/usr/bin/codesign")
        self.assertNotIn("--deep", args)
        self.assertIn("--timestamp", args)
        self.assertEqual(args[args.index("--sign") + 1], "A" * 40)
        args = m.windows_sign_command(windows(), "C:/Temp/App.exe")
        self.assertNotIn("/a", args)
        self.assertEqual(args[args.index("/fd") + 1], "SHA256")
        self.assertEqual(args[args.index("/td") + 1], "SHA256")
        self.assertIn(
            'certificate leaf = H"' + "A" * 40, m.requirement(mac(), mac()["targets"][-1])
        )

    def test_mac_verification_requires_timestamp_team_and_runtime(self):
        valid = "CodeDirectory v=20500 size=31 flags=0x10000(runtime) hashes=1\nTimestamp=Oct 19 2026\nTeamIdentifier=ABCDE12345\n"
        m.mac_metadata(valid, mac())
        for data in (
            valid.replace("runtime", "adhoc"),
            valid.replace("Timestamp=", "Signed Time="),
            valid.replace("ABCDE12345", "XXXXX12345"),
            valid + "Signature=adhoc\n",
        ):
            with self.assertRaises(m.SigningError):
                m.mac_metadata(data, mac())

    def test_authenticode_rejects_catalog_signatures_and_missing_timestamp(self):
        valid = {
            "status": "Valid",
            "type": "Authenticode",
            "thumbprint": "b" * 40,
            "timestamped": True,
        }
        m.windows_metadata(json.dumps(valid), windows())
        for change in (
            {"status": "HashMismatch"},
            {"type": "Catalog"},
            {"thumbprint": "a" * 40},
            {"timestamped": False},
        ):
            with self.assertRaises(m.SigningError):
                m.windows_metadata(json.dumps({**valid, **change}), windows())
        with self.assertRaises(m.SigningError):
            m.windows_metadata('{"status":"Valid","status":"Valid"}', windows())

    def test_signing_reorders_distribution_and_installed_byte_boundary(self):
        original = plan()
        saved = copy.deepcopy(original)
        result = m.attach(original, mac(), "policy.json", "a" * 64, "python")
        self.assertEqual(original, saved)
        self.assertEqual(result["tasks"]["app-assembly"]["outputs"], [])
        self.assertEqual(result["tasks"]["app-assembly"]["commands"][0][2], "fresh")
        self.assertEqual(
            result["tasks"]["app-assembly"]["commands"][1],
            original["tasks"]["app-assembly"]["commands"][0],
        )
        self.assertEqual(result["tasks"]["release-sign"]["outputs"][0]["fresh"], False)
        self.assertIn("release-sign", result["tasks"]["installer-compress"]["dependsOn"])
        self.assertEqual(result["tasks"]["release-sign"]["dependsOn"], ["app-assembly"])
        self.assertNotIn("release-sign", result["unsupported"])
        self.assertNotIn("environment", result["tasks"]["release-sign"])
        with self.assertRaises(m.SigningError):
            m.attach(result, mac(), "policy.json", "a" * 64, "python")

    def test_plan_cannot_sign_a_different_artifact_or_fabricate_stages(self):
        p = plan()
        p["tasks"]["app-assembly"]["outputs"][0]["path"] = "some-other-app"
        with self.assertRaises(m.SigningError):
            m.attach(p, mac(), "policy.json", "a" * 64, "python")
        p = plan()
        del p["unsupported"]["update"]
        with self.assertRaises(m.SigningError):
            m.attach(p, mac(), "policy.json", "a" * 64, "python")

    def test_inventory_detects_mutation_case_alias_and_hard_links(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "app"
            root.mkdir()
            file = root / "a"
            file.write_bytes(b"original")
            first = m.snapshot(root)
            file.write_bytes(b"changed")
            self.assertNotEqual(first["sha256"], m.snapshot(root)["sha256"])
            os.link(file, root / "hard-link")
            with self.assertRaisesRegex(m.SigningError, "hard-linked"):
                m.snapshot(root)
            (root / "hard-link").unlink()
            (root / "A").write_bytes(b"x")
            if (root / "A").stat().st_ino != file.stat().st_ino:
                with self.assertRaises(m.SigningError):
                    m.snapshot(root)
            else:
                # The filesystem itself prevents storing case-colliding entries.
                self.assertEqual(m.snapshot(root)["members"], 2)

    def test_internal_symlinks_are_inventoried_but_signing_targets_cannot_be_links(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "app"
            root.mkdir()
            (root / "a").write_bytes(b"x")
            try:
                (root / "link").symlink_to("a")
            except OSError as error:
                self.skipTest(
                    "Host does not permit symlink fixture creation: " + type(error).__name__
                )
            self.assertEqual(m.snapshot(root)["members"], 3)
            with self.assertRaises(m.SigningError):
                m.contained(d, "app/link")
            (root / "link").unlink()
            outside = Path(d) / "outside.txt"
            outside.write_bytes(b"outside fixture")
            (root / "link").symlink_to(outside.resolve())
            with self.assertRaises(m.SigningError):
                m.snapshot(root)

    def test_prepare_copies_only_pinned_inputs_without_mutating_original_policy(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "source"
            source.mkdir()
            dest = Path(d) / "dest"
            dest.mkdir()
            ent = plistlib.dumps({"com.apple.security.cs.allow-jit": True})
            (source / "ent.plist").write_bytes(ent)
            policy = mac()
            policy["targets"][-1]["entitlements"] = {
                "path": "ent.plist",
                "sha256": hashlib.sha256(ent).hexdigest(),
            }
            raw = json.dumps(policy).encode()
            (source / "policy.json").write_bytes(raw)
            result = m.prepare(
                plan(), dest, source / "policy.json", hashlib.sha256(raw).hexdigest()
            )
            copied = json.loads((dest / ".benchmark-native-signing/policy.json").read_bytes())
            self.assertEqual((source / "policy.json").read_bytes(), raw)
            self.assertEqual(
                (dest / copied["targets"][-1]["entitlements"]["path"]).read_bytes(), ent
            )
            self.assertIn("release-sign", result["tasks"])
            with self.assertRaises(m.SigningError):
                m.prepare(plan(), dest, source / "policy.json", hashlib.sha256(raw).hexdigest())

    def test_prepare_fails_before_writes_for_wrong_entitlements(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            dest = root / "dest"
            dest.mkdir()
            p = mac()
            p["targets"][-1]["entitlements"] = {"path": "ent.plist", "sha256": "a" * 64}
            (root / "ent.plist").write_bytes(plistlib.dumps({}))
            raw = json.dumps(p).encode()
            (root / "policy.json").write_bytes(raw)
            with self.assertRaises(m.SigningError):
                m.prepare(plan(), dest, root / "policy.json", hashlib.sha256(raw).hexdigest())
            self.assertEqual(list(dest.iterdir()), [])

    def test_real_cli_on_wrong_platform_writes_no_receipt_and_cannot_pass_stage(self):
        with tempfile.TemporaryDirectory() as d:
            p = mac() if sys.platform != "darwin" else windows()
            raw = json.dumps(p).encode()
            Path(d, "policy.json").write_bytes(raw)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "sign",
                    "policy.json",
                    hashlib.sha256(raw).hexdigest(),
                ],
                cwd=d,
                env={
                    **os.environ,
                    "BUNLY_BENCH_STAGE": "release-sign",
                    "BUNLY_BENCH_NONCE": "a" * 48,
                    "BUNLY_BENCH_RUN_ID": "b" * 48,
                },
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsupported-signing-platform", result.stderr)
            self.assertNotIn("benchmark-verification", result.stdout)
            self.assertFalse(Path(d, m.RECEIPT).exists())

    def test_real_native_command_adapter_checks_exit_and_output_overflow(self):
        self.assertEqual(
            m.native_command([sys.executable, "-c", "print('hello')"])[0], "hello" + os.linesep
        )
        with self.assertRaises(m.SigningError):
            m.native_command([sys.executable, "-c", "raise SystemExit(2)"])
        with self.assertRaises(m.SigningError):
            m.native_command([sys.executable, "-c", "import sys;sys.stdout.write('x'*2000000)"])

    def test_mocked_native_roundtrip_binds_receipt_and_rejects_post_sign_change(self):
        # This test deliberately mocks the platform APIs; it is not signature proof.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            artifact = root / mac()["artifact"]
            artifact.mkdir(parents=True)
            binary = artifact / "main"
            binary.write_bytes(b"unsigned fixture")
            (artifact / "Contents/Frameworks").mkdir(parents=True)
            (artifact / "Contents/Frameworks/helper.dylib").write_bytes(b"fixture")
            raw = json.dumps(mac()).encode()
            (root / "policy.json").write_bytes(raw)
            h = hashlib.sha256(raw).hexdigest()
            env = {
                "BUNLY_BENCH_STAGE": "release-sign",
                "BUNLY_BENCH_NONCE": "a" * 48,
                "BUNLY_BENCH_RUN_ID": "b" * 48,
            }
            with (
                patch.dict(os.environ, env),
                patch.object(m, "preflight", return_value=artifact),
                patch.object(m, "native_command", return_value=("", "")),
                patch.object(m, "verify_native") as verify,
            ):
                self.assertEqual(
                    m.execute("sign", root, "policy.json", h)["event"], "native-signing-applied"
                )
                self.assertTrue(m.execute("verify", root, "policy.json", h)["passed"])
                verify.assert_called_once()
                with self.assertRaises(m.SigningError):
                    m.execute("sign", root, "policy.json", h)
                binary.write_bytes(b"tampered")
                with self.assertRaisesRegex(m.SigningError, "signed-artifact-changed"):
                    m.execute("verify", root, "policy.json", h)

    def test_real_freshness_guard_preserved_after_moving_installed_accounting(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            raw = json.dumps(mac()).encode()
            (root / "policy.json").write_bytes(raw)
            h = hashlib.sha256(raw).hexdigest()
            with patch.dict(os.environ, {"BUNLY_BENCH_STAGE": "app-assembly"}):
                self.assertEqual(
                    m.execute("fresh", root, "policy.json", h)["event"],
                    "native-signing-freshness-checked",
                )
                (root / mac()["artifact"]).mkdir(parents=True)
                with self.assertRaisesRegex(m.SigningError, "already-exists"):
                    m.execute("fresh", root, "policy.json", h)
                self.assertTrue((root / mac()["artifact"]).is_dir())

    def test_timestamp_control_characters_and_signing_metadata_overlap(self):
        for url in ("https://tsa.test/\n", "https://tsa.test:abc", "https://tsa.test/a b"):
            with self.assertRaises(m.SigningError):
                m.validate_policy({**windows(), "timestampUrl": url})
        p = windows()
        p["artifact"] = ".benchmark-native-signing"
        p["targets"] = [{"path": ".benchmark-native-signing/test.exe"}]
        with self.assertRaises(m.SigningError):
            m.validate_policy(p)

    def test_bundle_executable_cannot_escape_via_info_plist(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            app = root / "App.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/MacOS/main").write_bytes(b"fixture")
            info = {"CFBundleIdentifier": "dev.test.app", "CFBundleExecutable": "main"}
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
            m.validate_app_bundle(root, "App.app", "dev.test.app")
            for name in ("../../outside", "/tmp/other", "C:/outside"):
                (app / "Contents/Info.plist").write_bytes(
                    plistlib.dumps({**info, "CFBundleExecutable": name})
                )
                with self.assertRaises(m.SigningError):
                    m.validate_app_bundle(root, "App.app", "dev.test.app")

    def test_nonce_policy_and_entitlement_changes_reject_before_native_tools(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            raw = json.dumps(mac()).encode()
            (root / "policy.json").write_bytes(raw)
            with self.assertRaisesRegex(m.SigningError, "policy-digest-mismatch"):
                m.load_policy(root, "policy.json", "e" * 64)
            with (
                patch.dict(
                    os.environ,
                    {
                        "BUNLY_BENCH_STAGE": "release-sign",
                        "BUNLY_BENCH_NONCE": "bad",
                        "BUNLY_BENCH_RUN_ID": "b" * 48,
                    },
                ),
                self.assertRaisesRegex(m.SigningError, "context-required"),
            ):
                m.execute("sign", root, "policy.json", hashlib.sha256(raw).hexdigest())

    def test_real_plan_cli_writes_exclusively(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            raw = json.dumps(mac()).encode()
            (p / "policy.json").write_bytes(raw)
            (p / "base.json").write_text(json.dumps(plan()))
            command = [
                sys.executable,
                str(SCRIPT),
                "plan",
                "policy.json",
                hashlib.sha256(raw).hexdigest(),
                "--base-plan",
                "base.json",
                "--output",
                "signed-plan.json",
            ]
            a = subprocess.run(command, cwd=d, capture_output=True, text=True, timeout=5)
            self.assertEqual(a.returncode, 0, a.stderr)
            output = (p / "signed-plan.json").read_bytes()
            b = subprocess.run(command, cwd=d, capture_output=True, timeout=5)
            self.assertNotEqual(b.returncode, 0)
            self.assertEqual((p / "signed-plan.json").read_bytes(), output)


if __name__ == "__main__":
    unittest.main()

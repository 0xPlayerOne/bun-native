"""Headless provenance and native-oracle checks, not GUI acceptance."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "native/cli-templates.py"
SPEC = importlib.util.spec_from_file_location("cli_templates", SCRIPT)
SCENARIO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCENARIO)


class TemplateScenarioTests(unittest.TestCase):
    def test_all_variants_share_the_exact_counter_tree_with_distinct_framework_titles(
        self,
    ):
        self.assertEqual(len(SCENARIO.CASES), 4)
        for framework in ("solid", "react"):
            initial = SCENARIO.counter_paint(framework, 0)
            final = SCENARIO.counter_paint(framework, 1)
            self.assertEqual(initial["tree_revision"], 1)
            self.assertEqual(final["tree_revision"], 2)
            self.assertEqual(initial["stage"], "native-paint")
            self.assertEqual(
                [node["node_id"] for node in initial["nodes"]], list(range(1, 7))
            )
            self.assertEqual(initial["nodes"][2]["children"], [4, 5, 6])
            self.assertEqual(
                initial["nodes"][3]["element"]["text"],
                f"Bun Native {framework.title()}",
            )
            self.assertEqual(initial["nodes"][4]["element"]["text"], "Clicks: 0")
            self.assertEqual(final["nodes"][4]["element"]["text"], "Clicks: 1")
            self.assertEqual(initial["nodes"][:4], final["nodes"][:4])
            self.assertEqual(initial["nodes"][5:], final["nodes"][5:])

    def test_real_file_fingerprints_reject_changed_same_size_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "host"
            path.write_bytes(b"first")
            identity = SCENARIO.artifact(path)
            self.assertEqual(identity["bytes"], 5)
            SCENARIO.require_artifact(path, {**identity, "profile": "release"})
            path.write_bytes(b"other")
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                SCENARIO.require_artifact(path, identity)

    def test_command_logs_keep_failure_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "failure.log"
            with self.assertRaisesRegex(RuntimeError, "exited 23"):
                SCENARIO.run_logged(
                    [
                        sys.executable,
                        "-c",
                        "print('retained failure'); raise SystemExit(23)",
                    ],
                    output,
                    directory,
                )
            self.assertIn("retained failure", output.read_text())

    def test_launch_requires_prepared_identities_and_aot_uses_adjacent_host(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            root = Path(directory)
            case = "solid-typescript"
            package = root / case / "package"
            source = root / case / "source"
            (package / "development").mkdir(parents=True)
            source.mkdir()
            bun = root / "bun"
            host = root / "release-host"
            bun.write_bytes(b"compiler")
            host.write_bytes(b"native host")
            (source / "main.tsx").write_text("unchanged template")
            for file, content in [
                ("application", b"compiled"),
                ("development/application.js", b"module"),
                ("bun-native-host", b"native host"),
            ]:
                (package / file).write_bytes(content)
            manifest = {
                key: {"file": file, **SCENARIO.artifact(package / file)}
                for key, file in [
                    ("application", "application"),
                    ("developmentModule", "development/application.js"),
                    ("host", "bun-native-host"),
                ]
            }
            (package / "manifest.json").write_text(json.dumps(manifest))
            provenance = {
                "source": {"commit": "test-only"},
                "compiler": {"path": str(bun), **SCENARIO.artifact(bun)},
                "host": {"path": str(host), **SCENARIO.artifact(host)},
                "cases": {
                    case: {
                        "framework": "solid",
                        "manifest": SCENARIO.artifact(package / "manifest.json"),
                        "source": [
                            {
                                "path": "main.tsx",
                                **SCENARIO.artifact(source / "main.tsx"),
                            }
                        ],
                    }
                },
            }
            (root / "provenance.json").write_text(json.dumps(provenance))
            with patch.object(
                SCENARIO, "source_identity", return_value=provenance["source"]
            ):
                for mode in ("development", "aot"):
                    command = SCENARIO.scenario(root, case, mode, root / "evidence")
                    self.assertIn("--expect-native-pointer", command)
                    self.assertNotIn("--expect-event", command)
                    if mode == "development":
                        self.assertIn(
                            str(SCENARIO.REPOSITORY / "tests/native/cli-dev-owner.ts"),
                            command,
                        )
                        self.assertEqual(
                            command[-4:], ["--source", str(source), "--host", str(host)]
                        )
                        self.assertNotIn(
                            str(package / "development/application.js"), command
                        )
                        self.assertNotIn("BUN_NATIVE_HOST", os.environ)
                    else:
                        self.assertIn(
                            str(
                                SCENARIO.REPOSITORY
                                / "tests/native/cli-template-owner.ts"
                            ),
                            command,
                        )
                        self.assertEqual(command[-1], str(package / "application"))
                        self.assertNotIn("BUN_NATIVE_HOST", os.environ)
                for path in [
                    bun,
                    host,
                    package / "manifest.json",
                    package / "application",
                    package / "development/application.js",
                    package / "bun-native-host",
                    source / "main.tsx",
                ]:
                    original = path.read_bytes()
                    path.write_bytes(b"changed")
                    with (
                        self.subTest(path=path),
                        self.assertRaisesRegex(RuntimeError, "identity changed"),
                    ):
                        SCENARIO.scenario(root, case, "aot", root / "evidence")
                    path.write_bytes(original)
            with (
                patch.object(
                    SCENARIO, "source_identity", return_value={"commit": "different"}
                ),
                self.assertRaisesRegex(RuntimeError, "differs"),
            ):
                SCENARIO.scenario(root, case, "aot", root / "evidence")


if __name__ == "__main__":
    unittest.main()

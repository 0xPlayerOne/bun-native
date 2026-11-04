"""File/receipt controls only; the specimen is never installed, compiled or run."""

import copy
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "standalone_package_evidence",
    ROOT / "scripts/quality/standalone-package-evidence.py",
)
EVIDENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVIDENCE)


class BuildEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / "consumer"
        self.dist = self.project / "dist"
        (self.dist / "development").mkdir(parents=True)
        (self.project / "vendor/bun-native").mkdir(parents=True)
        (self.project / "vendor/bun-native/manifest.json").write_text("{}")
        (self.project / "main.tsx").write_text("inert source; never executed")
        self.mapping = self.dist / "development/application.js.map"
        self.mapping.write_text(
            json.dumps({"version": 3, "sources": ["../../main.tsx"]})
        )
        self.bun = self.root / "pinned-bun"
        self.source = {"commit": "fixture-commit", "tree": "fixture-tree"}
        self.toolchain = {"revision": "fixture-revision"}
        self.manifest = {
            "packageSet": {
                "source": self.source,
                "manifest": EVIDENCE.digest(
                    self.project / "vendor/bun-native/manifest.json"
                ),
            },
            "toolchain": self.toolchain,
            "verification": {
                key: "not-run" for key in ("nativeRendering", "osInput", "teardown")
            },
        }
        for field, name in [
            ("application", "application"),
            ("host", "host"),
            ("developmentModule", "development/application.js"),
        ]:
            path = self.dist / name
            path.write_bytes(("inert " + field).encode())
            self.manifest[field] = {"file": name, **EVIDENCE.digest(path)}
        self.manifest["application"].update(
            {
                "inspection": {"hasCompiledProgram": True},
                "runtimeFeatures": {"jit": "omitted", "jitRemovedRanges": {"count": 1}},
                "compileCommand": [str(self.bun), "--no-install", "compile"],
            }
        )
        self.host = EVIDENCE.digest(self.dist / "host")
        self.save()

    def save(self):
        (self.dist / "manifest.json").write_text(json.dumps(self.manifest))

    def receipt(self, **changes):
        arguments = {
            "source": self.source,
            "toolchain": self.toolchain,
            "host": self.host,
            "bun": self.bun,
            **changes,
        }
        return EVIDENCE.build_receipt(self.project, **arguments)

    def test_complete_file_receipt_and_each_explicit_producer_identity(self):
        receipt = self.receipt()
        self.assertEqual(receipt["manifest"], self.manifest)
        self.assertEqual(
            receipt["mapped_sources"],
            {"main.tsx": EVIDENCE.digest(self.project / "main.tsx")},
        )
        self.assertEqual(receipt["source_map"], EVIDENCE.digest(self.mapping))
        for changed in [
            {"source": {}},
            {"toolchain": {}},
            {"host": {}},
            {"bun": self.root / "other-bun"},
        ]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                self.receipt(**changed)

    def test_manifest_cannot_substitute_build_or_native_acceptance(self):
        baseline = copy.deepcopy(self.manifest)
        changes = [
            ("inspection", {"hasCompiledProgram": False}),
            ("runtimeFeatures", {"jit": "present", "jitRemovedRanges": {"count": 1}}),
            ("runtimeFeatures", {"jit": "omitted", "jitRemovedRanges": {"count": 0}}),
            ("compileCommand", [str(self.bun), "compile"]),
        ]
        for key, value in changes:
            self.manifest = copy.deepcopy(baseline)
            self.manifest["application"][key] = value
            self.save()
            with self.subTest(field=key, value=value), self.assertRaises(RuntimeError):
                self.receipt()
        for field in ("nativeRendering", "osInput", "teardown"):
            self.manifest = copy.deepcopy(baseline)
            self.manifest["verification"][field] = "passed"
            self.save()
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(RuntimeError, "overstates"),
            ):
                self.receipt()

    def test_changed_artifact_and_package_set_bytes_are_rejected(self):
        for name in (
            "application",
            "host",
            "development/application.js",
            "../vendor/bun-native/manifest.json",
        ):
            path = self.dist / name
            original = path.read_bytes()
            path.write_bytes(b"changed")
            with self.subTest(path=name), self.assertRaises(RuntimeError):
                self.receipt()
            path.write_bytes(original)

    def test_source_map_requires_real_inputs_contained_in_the_consumer(self):
        outside = self.root / "foreign.ts"
        outside.write_text("not a consumer input")
        (self.project / "linked.ts").symlink_to(outside)
        for mapping in [
            {"version": 3, "sources": []},
            {"version": 2, "sources": ["../../main.tsx"]},
            {"version": 3, "sources": [str(outside)]},
            {"version": 3, "sources": ["../../linked.ts"]},
            {"version": 3, "sources": ["../../vendor"]},
            {"version": 3, "sources": ["../../missing.ts"]},
        ]:
            self.mapping.write_text(json.dumps(mapping))
            with (
                self.subTest(mapping=mapping),
                self.assertRaises((RuntimeError, OSError)),
            ):
                self.receipt()

    def test_retained_map_uses_its_original_module_location(self):
        original = self.project / ".bun-native/dev-retired"
        original.mkdir(parents=True)
        retained = self.root / "retained-map.json"
        retained.write_bytes(self.mapping.read_bytes())
        shutil.rmtree(original)
        with self.assertRaises(OSError):
            EVIDENCE.source_map_receipt(self.project, retained)
        receipt = EVIDENCE.source_map_receipt(
            self.project, retained, original_directory=original
        )
        self.assertEqual(
            receipt["mapped_sources"],
            {"main.tsx": EVIDENCE.digest(self.project / "main.tsx")},
        )
        self.assertEqual(receipt["source_map"], EVIDENCE.digest(self.mapping))

    def test_retained_map_keeps_symlink_and_missing_intermediate_semantics(self):
        original = self.project / ".bun-native/dev-retired"
        original.mkdir(parents=True)
        retained = self.root / "retained-map.json"
        foreign = self.root / "foreign"
        (foreign / "child").mkdir(parents=True)
        (foreign / "input.ts").write_text("foreign source")
        (self.project / "input.ts").write_text(
            "a lexical collapse would wrongly read this"
        )
        (self.project / "alias").symlink_to(foreign / "child", target_is_directory=True)
        shutil.rmtree(original)
        for source in ("../../alias/../input.ts", "../../missing/../main.tsx"):
            retained.write_text(json.dumps({"version": 3, "sources": [source]}))
            with (
                self.subTest(source=source),
                self.assertRaises((RuntimeError, OSError)),
            ):
                EVIDENCE.source_map_receipt(
                    self.project, retained, original_directory=original
                )
        retained.write_text(
            json.dumps({"version": 3, "sourceRoot": "../../", "sources": ["main.tsx"]})
        )
        receipt = EVIDENCE.source_map_receipt(
            self.project, retained, original_directory=original
        )
        self.assertEqual(
            receipt["mapped_sources"],
            {"main.tsx": EVIDENCE.digest(self.project / "main.tsx")},
        )
        with self.assertRaisesRegex(RuntimeError, "Original module directory escapes"):
            EVIDENCE.source_map_receipt(
                self.project, retained, original_directory=foreign / "dev-retired"
            )


class BuildDiagnosticRetentionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "consumer"
        (self.project / "dist").mkdir(parents=True)
        self.originals = {
            "compile-aot.stdout.log": b'{"inert":true}\r\n',
            "compile-aot.stderr.log": b"inert diagnostics\n\x00",
            "launcher.ts": b"// inert launcher; never executed\n",
        }
        for name, data in self.originals.items():
            (self.project / "dist" / name).write_bytes(data)

    def test_retains_exact_bytes_and_digests_without_overwriting_prior_evidence(self):
        destination = self.root / "retained"
        files = EVIDENCE.retain_build_diagnostics(self.project, destination)
        self.assertEqual(set(files), set(self.originals))
        for name, original in self.originals.items():
            self.assertEqual((destination / name).read_bytes(), original)
            self.assertEqual(files[name], EVIDENCE.digest(destination / name))
        (self.project / "dist/launcher.ts").write_bytes(b"changed later")
        with self.assertRaises(FileExistsError):
            EVIDENCE.retain_build_diagnostics(self.project, destination)
        self.assertEqual(
            (destination / "launcher.ts").read_bytes(), self.originals["launcher.ts"]
        )

    def test_missing_or_linked_diagnostic_cannot_become_a_complete_receipt(self):
        source = self.project / "dist/compile-aot.stdout.log"
        source.unlink()
        with self.assertRaisesRegex(
            RuntimeError, "Missing regular AOT build diagnostic"
        ):
            EVIDENCE.retain_build_diagnostics(self.project, self.root / "missing")
        outside = self.root / "outside.log"
        outside.write_bytes(b"not a producer output")
        source.symlink_to(outside)
        with self.assertRaisesRegex(
            RuntimeError, "Missing regular AOT build diagnostic"
        ):
            EVIDENCE.retain_build_diagnostics(self.project, self.root / "linked")
        self.assertEqual(outside.read_bytes(), b"not a producer output")


if __name__ == "__main__":
    unittest.main()

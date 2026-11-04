"""Mechanical provenance checks for the real vendored HAL and corruption controls."""

import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "wgpu_vendor", ROOT / "scripts/quality/verify-wgpu-vendor.py"
)
VENDOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VENDOR)
PACKAGE = ROOT / "native/vendor/wgpu-hal"


class VendoredHalProvenance(unittest.TestCase):
    def test_committed_package_matches_exact_upstream_plus_reviewed_patches(self):
        result = VENDOR.verify(PACKAGE)
        self.assertEqual(result["upstream_files"], 86)
        self.assertEqual(result["revision"], "cddb2f5d80dc0009b2ef6767635140cacf90a007")
        self.assertEqual(
            result["patches"],
            [
                "construction-rollback.patch",
                "pbuffer-owner-release.patch",
                "renderdoc-null-api.patch",
            ],
        )

    def test_rejects_extra_source_edits_inside_and_outside_patched_file(self):
        for name in (
            "src/gles/egl.rs",
            "src/auxil/renderdoc.rs",
            "src/vulkan/instance.rs",
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                package = Path(directory) / "wgpu-hal"
                shutil.copytree(PACKAGE, package)
                path = package / name
                source = path.read_text()
                if name == "src/auxil/renderdoc.rs":
                    # Change an untouched line outside the reviewed hunks.
                    source = source.replace(
                        "pub type Handle = *mut ffi::c_void;",
                        "pub type Handle = *mut ffi::c_void; // Unreviewed change.",
                    )
                else:
                    source += "\n// Unreviewed source change.\n"
                path.write_text(source)
                with self.assertRaisesRegex(ValueError, "upstream source mismatch"):
                    VENDOR.verify(package)

    def test_rejects_changed_or_undeclared_renderdoc_patch(self):
        for change in ("patch", "declaration"):
            with (
                self.subTest(change=change),
                tempfile.TemporaryDirectory() as directory,
            ):
                package = Path(directory) / "wgpu-hal"
                shutil.copytree(PACKAGE, package)
                proof = package / "bun-native"
                if change == "patch":
                    patch = proof / "renderdoc-null-api.patch"
                    patch.write_bytes(
                        patch.read_bytes() + b"\nUnreviewed patch bytes\n"
                    )
                    message = "reviewed patch changed"
                else:
                    path = proof / "upstream.json"
                    receipt = json.loads(path.read_text())
                    del receipt["patches"]["renderdoc-null-api.patch"]
                    path.write_text(json.dumps(receipt))
                    message = "unexpected patch inventory or order"
                with self.assertRaisesRegex(ValueError, message):
                    VENDOR.verify(package)

    def test_rejects_registry_substitution_of_same_version_sibling(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "wgpu-hal"
            shutil.copytree(PACKAGE, package)
            path = package / "Cargo.toml"
            source = path.read_text()
            start = source.index("wgpu-types = ")
            end = source.index("\n", start)
            changed = (
                source[:start]
                + 'wgpu-types = { version = "30.0.0", default-features = false }'
                + source[end:]
            )
            path.write_text(changed)
            with self.assertRaisesRegex(ValueError, "standalone manifest differs"):
                VENDOR.verify(package)

    def test_receipt_cannot_relabel_changed_source_as_the_pinned_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "wgpu-hal"
            shutil.copytree(PACKAGE, package)
            path = package / "src/vulkan/instance.rs"
            data = (
                path.read_bytes()
                + b"\n// Changed source and matching per-file receipt.\n"
            )
            path.write_bytes(data)
            receipt = package / "bun-native/upstream.json"
            value = json.loads(receipt.read_text())
            item = value["files"]["src/vulkan/instance.rs"]
            item.update(
                bytes=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
                git_blob=hashlib.sha1(
                    f"blob {len(data)}\0".encode() + data
                ).hexdigest(),
            )
            value["package_tree"] = VENDOR.git_tree(value["files"])
            receipt.write_text(json.dumps(value))
            with self.assertRaisesRegex(
                ValueError, "upstream package tree identity mismatch"
            ):
                VENDOR.verify(package)

    def test_rejects_missing_license_and_extra_source(self):
        for missing in (True, False):
            with (
                self.subTest(missing=missing),
                tempfile.TemporaryDirectory() as directory,
            ):
                package = Path(directory) / "wgpu-hal"
                shutil.copytree(PACKAGE, package)
                if missing:
                    (package / "LICENSE.MIT").unlink()
                else:
                    (package / "src/unreviewed.rs").write_text("pub fn added() {}\n")
                with self.assertRaisesRegex(ValueError, "vendor inventory changed"):
                    VENDOR.verify(package)


if __name__ == "__main__":
    unittest.main()

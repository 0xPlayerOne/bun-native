"""Mechanical provenance checks for the vendored GPUI crates and corruption controls."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from scripts.quality.native_harness import verify_gpui_vendor as VENDOR

ROOT = Path(__file__).resolve().parents[2]
VENDORED = ROOT / "native/vendor"


class VendoredGpuiProvenance(unittest.TestCase):
    def copy(self, directory, name="gpui_linux"):
        package = Path(directory) / name
        shutil.copytree(VENDORED / name, package)
        return package

    def test_committed_packages_match_exact_upstream_plus_reviewed_patches(self):
        expected = {
            "gpui_linux": ["credentials-feature.patch", "accesskit-delta.patch"],
            "gpui_macos": [
                "metal-display-link-switch.patch",
                "cvdisplaylink-keep-subscribed.patch",
            ],
            "gpui_wgpu": ["shared-pipelines.patch"],
        }
        self.assertEqual(tuple(expected), VENDOR.PACKAGES)
        for name, patches in expected.items():
            with self.subTest(package=name):
                result = VENDOR.verify(VENDORED / name)
                self.assertEqual(result["patches"], patches)
                self.assertGreater(result["upstream_files"], 10)

    def test_rejects_edits_outside_inside_and_beside_the_patches(self):
        edits = {
            # An upstream file no patch touches.
            "src/linux/dispatcher.rs": "upstream source mismatch",
            # A patched file, outside the patch's hunks.
            "src/linux/platform.rs": "upstream source mismatch",
            # A file the patch adds.
            "src/linux/accesskit_delta.rs": "returned non-zero exit status",
        }
        for name, message in edits.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                package = self.copy(directory)
                path = package / name
                lines = path.read_text().splitlines(keepends=True)
                lines.insert(len(lines) // 2, "// unreviewed\n")
                path.write_text("".join(lines))
                with self.assertRaisesRegex(Exception, message):
                    VENDOR.verify(package)

    def test_rejects_extra_files_and_changed_or_unrecorded_patches(self):
        with tempfile.TemporaryDirectory() as directory:
            package = self.copy(directory)
            (package / "src/extra.rs").write_text("")
            with self.assertRaisesRegex(ValueError, "vendor inventory changed"):
                VENDOR.verify(package)
        with tempfile.TemporaryDirectory() as directory:
            package = self.copy(directory)
            patch = package / "bun-native/credentials-feature.patch"
            patch.write_text(patch.read_text() + "\n")
            with self.assertRaisesRegex(ValueError, "reviewed patch changed"):
                VENDOR.verify(package)
        with tempfile.TemporaryDirectory() as directory:
            package = self.copy(directory)
            receipt_path = package / "bun-native/upstream.json"
            receipt = json.loads(receipt_path.read_text())
            del receipt["patches"]["credentials-feature.patch"]
            receipt_path.write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError, "patched and added files"):
                VENDOR.verify(package)


if __name__ == "__main__":
    unittest.main()

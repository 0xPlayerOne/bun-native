"""Policy tests; actual native signing and tamper rejection have separate recorded runs."""

import plistlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import qualify_adhoc_signing as subject
from native_signing_policy import SigningError, snapshot


class LocalSigningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / ".bunly/input/Fixture.app"
        (self.app / "Contents/MacOS").mkdir(parents=True)
        (self.app / "Contents/MacOS/main").write_bytes(bytes.fromhex("cffaedfe") + b"fixture")
        (self.app / "Contents/Info.plist").write_bytes(
            plistlib.dumps({"CFBundleIdentifier": "dev.bunly.test", "CFBundleExecutable": "main"})
        )
        self.output = self.root / ".bunly/output"

    def test_source_pin_and_private_scope(self):
        pin = snapshot(self.app)["sha256"]
        self.assertEqual(subject.inputs(self.app, self.output, pin, self.root)[2]["sha256"], pin)
        for destination in (self.app / "output", self.root, self.root / "outside"):
            with self.assertRaises(SigningError):
                subject.inputs(self.app, destination, pin, self.root)
        with self.assertRaises(SigningError):
            subject.inputs(self.app, self.output, "0" * 64, self.root)

    def test_stale_output_is_not_overwritten(self):
        self.output.mkdir()
        with self.assertRaises(SigningError):
            subject.inputs(self.app, self.output, snapshot(self.app)["sha256"], self.root)

    def test_unrelated_app_and_linked_source_are_rejected(self):
        pin = snapshot(self.app)["sha256"]
        linked = self.app.parent / "Link.app"
        linked.symlink_to(self.app)
        with self.assertRaises(SigningError):
            subject.inputs(linked, self.output, pin, self.root)
        (self.app / "Contents/Info.plist").write_bytes(
            plistlib.dumps({"CFBundleIdentifier": "com.unrelated.app"})
        )
        with self.assertRaises(SigningError):
            subject.inputs(self.app, self.output, snapshot(self.app)["sha256"], self.root)

    def test_targets_are_inside_out_with_outer_app_last(self):
        nested = self.app / "Contents/Frameworks/Helper.app"
        (nested / "Contents/MacOS").mkdir(parents=True)
        binary = nested / "Contents/MacOS/helper"
        binary.write_bytes(bytes.fromhex("cffaedfe") + b"nested")
        plan = subject.targets(self.app)
        self.assertEqual(plan[-1], self.app)
        self.assertLess(plan.index(binary), plan.index(nested))
        self.assertLess(plan.index(nested), plan.index(self.app))
        self.assertNotIn(self.app / "Contents/Info.plist", plan)

    def test_escaping_link_and_hardlink_are_not_signed(self):
        outside = self.root / "outside"
        outside.write_bytes(b"outside")
        link = self.app / "outside-link"
        link.symlink_to(outside)
        with self.assertRaises(SigningError):
            subject.targets(self.app)
        link.unlink()
        link.hardlink_to(outside)
        with self.assertRaises(SigningError):
            subject.targets(self.app)

    def test_command_never_selects_certificate_or_uses_deep_signing(self):
        command = subject.sign_command(self.app)
        self.assertEqual(command[command.index("--sign") + 1], "-")
        self.assertIn("--timestamp=none", command)
        self.assertNotIn("--deep", command)
        self.assertIn("--preserve-metadata=identifier,entitlements,flags", command)

    def test_certificate_metadata_cannot_pass_as_adhoc(self):
        subject.validate_metadata("Signature=adhoc\nTeamIdentifier=not set\n")
        for text in (
            "Authority=Developer ID\n",
            "Signature=adhoc\nTimestamp=today\n",
            "Signature=adhoc\nAuthority=other\n",
            "Signature=adhoc-not\n",
        ):
            with self.assertRaises(SigningError):
                subject.validate_metadata(text)

    def test_unsupported_platform_rejects_before_filesystem_change(self):
        with patch.object(subject.sys, "platform", "linux"), self.assertRaises(SigningError):
            subject.measure(self.app, self.output, "0" * 64)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()

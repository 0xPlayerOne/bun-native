"""Real archive checks on synthetic app files, not native installer acceptance."""

import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "reference_archive", Path(__file__).resolve().parents[1] / "scripts/reference_archive.py"
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.app = self.root / "App"
        self.app.mkdir()
        (self.app / "entry").write_bytes(b"executable fixture")
        (self.app / "entry").chmod(0o755)
        (self.app / "assets").mkdir()
        (self.app / "assets" / "unicode-\u00e9.txt").write_text("asset")
        self.archive = self.root / "app.tar.gz"

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_verify_and_repeatable_bytes(self):
        module.create(self.app, self.archive)
        self.assertEqual(module.verify(self.app, self.archive), 4)
        other = self.root / "other.tar.gz"
        module.create(self.app, other)
        self.assertEqual(self.archive.read_bytes(), other.read_bytes())

    def test_internal_relative_link_preserved_without_extraction(self):
        (self.app / "current").symlink_to("assets")
        module.create(self.app, self.archive)
        self.assertEqual(module.verify(self.app, self.archive), 5)
        with tarfile.open(self.archive, "r:gz") as archive:
            self.assertTrue(archive.getmember("BunlyReference/current").issym())

    def test_escaping_link_rejected(self):
        (self.app / "escape").symlink_to("../outside")
        with self.assertRaises(ValueError):
            module.create(self.app, self.archive)

    def test_ancestor_alias_keeps_internal_links_valid(self):
        alias = self.root / "parent-alias"
        alias.symlink_to(self.root, target_is_directory=True)
        (self.app / "current").symlink_to("assets")
        module.create(alias / "App", self.archive)
        self.assertEqual(module.verify(self.app, self.archive), 5)

    def test_direct_root_link_remains_rejected(self):
        alias = self.root / "linked-app"
        alias.symlink_to(self.app, target_is_directory=True)
        with self.assertRaises(ValueError):
            module.inventory(alias)

    def test_aliased_output_inside_source_is_rejected(self):
        alias = self.root / "parent-alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            module.create(self.app, alias / "App" / "nested.tar.gz")
        self.assertFalse((self.app / "nested.tar.gz").exists())

    def test_stale_destination_is_not_overwritten(self):
        self.archive.write_bytes(b"existing")
        with self.assertRaises(FileExistsError):
            module.create(self.app, self.archive)
        self.assertEqual(self.archive.read_bytes(), b"existing")

    def test_changed_source_cannot_validate_old_archive(self):
        module.create(self.app, self.archive)
        (self.app / "entry").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            module.verify(self.app, self.archive)

    def test_single_executable_is_supported(self):
        source = self.app / "entry"
        module.create(source, self.archive)
        self.assertEqual(module.verify(source, self.archive), 1)

    def test_unexpected_archive_member_is_rejected_without_extraction(self):
        with tarfile.open(self.archive, "w:gz") as archive:
            item = tarfile.TarInfo("../../escape")
            item.size = 1
            archive.addfile(item, io.BytesIO(b"x"))
        with self.assertRaises(ValueError):
            module.verify(self.app, self.archive)
        self.assertFalse((self.root / "escape").exists())

    def test_archive_cannot_include_itself(self):
        with self.assertRaises(ValueError):
            module.create(self.app, self.app / "nested.tar.gz")


if __name__ == "__main__":
    unittest.main()

"""Native evidence must fingerprint local dependency build inputs, including assets."""

import hashlib
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "linux", "Linux evidence source snapshots")
class NativeVendorInputs(unittest.TestCase):
    def test_all_local_dependency_compile_inputs_are_fingerprinted(self):
        expected = set()
        for package in (ROOT / "native/vendor").iterdir():
            if not package.is_dir():
                continue
            for name in ("Cargo.toml", "build.rs"):
                if (path := package / name).is_file():
                    expected.add(path)
            expected.update(
                path for path in (package / "src").rglob("*") if path.is_file()
            )
        self.assertIn(ROOT / "native/vendor/wgpu-hal/build.rs", expected)
        self.assertIn(
            ROOT / "native/vendor/wgpu-hal/src/gles/shaders/clear.frag", expected
        )
        for name in ("native-diagnostics-linux", "native-allocation-linux"):
            with self.subTest(runner=name):
                spec = importlib.util.spec_from_file_location(
                    name.replace("-", "_"), ROOT / f"scripts/quality/{name}.py"
                )
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                snapshot = module.source_snapshot()
                missing = {
                    str(path.relative_to(ROOT)) for path in expected
                } - snapshot.keys()
                self.assertEqual(missing, set(), "missing local native compile inputs")
                for path in expected:
                    with self.subTest(path=path.relative_to(ROOT)):
                        record = snapshot[str(path.relative_to(ROOT))]
                        self.assertEqual(record["bytes"], path.stat().st_size)
                        self.assertEqual(
                            record["sha256"],
                            hashlib.sha256(path.read_bytes()).hexdigest(),
                        )


if __name__ == "__main__":
    unittest.main()

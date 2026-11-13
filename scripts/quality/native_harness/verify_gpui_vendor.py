"""Verify the vendored GPUI crates against their recorded upstream sources.

Each of `native/vendor/gpui_linux`, `gpui_macos` and `gpui_wgpu` is one zed
crate at the lockfile's revision plus the reviewed patches its `bun-native/`
directory records. Every upstream file must still hash as recorded, the
patches must be exactly the recorded ones, and reversing them in a disposable
copy must restore the recorded upstream bytes of every patched file and remove
every added one, so no edit can hide outside or inside a patched file. The
standalone `Cargo.toml` is reviewed by hand (its README lists the changes);
the preserved upstream manifests are checked here.
"""

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

REPOSITORY = "https://github.com/zed-industries/zed"
COMMIT = "ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d"
WORKSPACE_SHA256 = "1e7c07401d52902c7070c7b0ca7584f32e9dde25e17829947b3292c895f8f255"
PACKAGES = ("gpui_linux", "gpui_macos", "gpui_wgpu")
PROOF_FILES = {
    "Cargo.toml.upstream",
    "workspace.toml.upstream",
    "upstream.json",
    "README.md",
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def touched(patch):
    """The files one patch creates or changes, from its `+++` headers."""
    names = set()
    for line in patch.read_text().splitlines():
        if line.startswith("+++ b/"):
            names.add(line.removeprefix("+++ b/"))
    return names


def verify(package):
    package = Path(package)
    proof = package / "bun-native"
    receipt = json.loads((proof / "upstream.json").read_text())
    if (
        receipt["repository"] != REPOSITORY
        or receipt["commit"] != COMMIT
        or receipt["package"] != f"crates/{package.name}"
    ):
        raise ValueError("unexpected upstream identity")
    if sha256((proof / "workspace.toml.upstream").read_bytes()) != WORKSPACE_SHA256:
        raise ValueError("upstream workspace manifest changed")
    if receipt["workspace_manifest_sha256"] != WORKSPACE_SHA256:
        raise ValueError("recorded workspace manifest changed")

    patches = receipt["patches"]
    added = set(receipt.get("added", []))
    patched = set(receipt["patched"])
    files = receipt["files"]
    changed = set()
    for name, expected in patches.items():
        path = proof / name
        if sha256(path.read_bytes()) != expected:
            raise ValueError(f"reviewed patch changed: {name}")
        changed |= touched(path)
    if changed != patched | added or added & set(files) or not patched <= set(files):
        raise ValueError("patched and added files differ from the patches")

    expected_files = set(files) | added | {f"bun-native/{name}" for name in PROOF_FILES}
    expected_files |= {f"bun-native/{name}" for name in patches}
    actual_files = set()
    for path in package.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"unexpected vendored symlink: {path}")
        if path.is_file():
            actual_files.add(path.relative_to(package).as_posix())
    if actual_files != expected_files:
        raise ValueError(
            f"vendor inventory changed: {sorted(actual_files ^ expected_files)}"
        )

    # Reverse the recorded patches, last first, in a disposable copy of the
    # files they touch. No shared checkout is ever edited.
    with tempfile.TemporaryDirectory(prefix="bun-native-gpui-proof-") as temporary:
        root = Path(temporary)
        for name in changed:
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package / name, destination)
        for name in reversed(list(patches)):
            subprocess.run(
                ["git", "apply", "--reverse", str((proof / name).resolve())],
                cwd=root,
                capture_output=True,
                check=True,
                timeout=10,
            )
        if any((root / name).exists() for name in added):
            raise ValueError("reversing the patches left an added file")
        for name, expected in files.items():
            if name == "Cargo.toml":
                data = (proof / "Cargo.toml.upstream").read_bytes()
            elif name in patched:
                data = (root / name).read_bytes()
            else:
                data = (package / name).read_bytes()
            if len(data) != expected["bytes"] or sha256(data) != expected["sha256"]:
                raise ValueError(f"upstream source mismatch: {name}")
    return {
        "package": package.name,
        "upstream_files": len(files),
        "patches": list(patches),
    }

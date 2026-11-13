"""Verify the exact pinned HAL copy, standalone manifest and reviewed patches."""

import argparse
import copy
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import tomllib
from pathlib import Path

from .common import ROOT

REPOSITORY = "https://github.com/gfx-rs/wgpu"
REVISION = "cddb2f5d80dc0009b2ef6767635140cacf90a007"
PACKAGE_TREE = "6a77b79e0f0624d7ac66aad3301f7ae244cbefaa"
WORKSPACE_SHA256 = "b9790454c133248714a94e296381ed8dcbc4bf88860fb8e2038918dc555e0fb0"
SIBLINGS = {"naga", "naga-types", "wgpu-naga-bridge", "wgpu-sync", "wgpu-types"}
PROOF_FILES = {
    "Cargo.toml.upstream",
    "workspace.toml.upstream",
    "upstream.json",
    "construction-rollback.patch",
    "pbuffer-owner-release.patch",
    "renderdoc-null-api.patch",
    "README.md",
}
PATCHES = (
    "construction-rollback.patch",
    "pbuffer-owner-release.patch",
    "renderdoc-null-api.patch",
)
PATCHED_FILES = ("src/gles/egl.rs", "src/auxil/renderdoc.rs")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git_tree(files):
    """Reconstruct the upstream tree identity from verified file blob identities."""
    tree = {}
    for name, entry in files.items():
        parts = name.split("/")
        if any(part in ("", ".", "..") for part in parts) or entry["mode"] != "100644":
            raise ValueError(f"unexpected upstream file path or mode: {name}")
        node = tree
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = entry["git_blob"]

    def identity(node):
        data = bytearray()
        for name, value in sorted(
            node.items(),
            key=lambda item: (
                item[0] + ("/" if isinstance(item[1], dict) else "")
            ).encode(),
        ):
            directory = isinstance(value, dict)
            mode, blob = ("40000", identity(value)) if directory else ("100644", value)
            data.extend(f"{mode} {name}\0".encode() + bytes.fromhex(blob))
        return hashlib.sha1(f"tree {len(data)}\0".encode() + data).hexdigest()

    return identity(tree)


def inline(value):
    if isinstance(value, dict):
        return (
            "{ "
            + ", ".join(f"{key} = {inline(item)}" for key, item in value.items())
            + " }"
        )
    return json.dumps(value, ensure_ascii=False)


def materialize_manifest(original, workspace_source):
    """Expand only the inherited declarations in this fixed upstream manifest."""
    workspace = tomllib.loads(workspace_source)["workspace"]
    package = tomllib.loads(original)["package"]

    def replacement(match):
        name, dotted, attributes = match.groups()
        if (
            dotted
            and isinstance(package.get(name), dict)
            and package[name].get("workspace")
        ):
            return f"{name} = {inline(workspace['package'][name])}"
        inherited = copy.deepcopy(workspace["dependencies"][name])
        if isinstance(inherited, str):
            inherited = {"version": inherited}
        local = (
            tomllib.loads("dependency = " + attributes)["dependency"]
            if attributes
            else {}
        )
        local.pop("workspace", None)
        features = list(
            dict.fromkeys(inherited.get("features", []) + local.get("features", []))
        )
        inherited.update(local)
        if features:
            inherited["features"] = features
        if "path" in inherited:
            if name not in SIBLINGS:
                raise ValueError(f"unexpected upstream path dependency: {name}")
            del inherited["path"]
            inherited.update(git=REPOSITORY, rev=REVISION)
        return f"{name} = {inline(inherited)}"

    source = re.sub(
        r"(?m)^([\w-]+)(?:(\.workspace\s*=\s*true)|\s*=\s*(\{\s*workspace\s*=\s*true[^}]*\}))",
        replacement,
        original,
    )
    if re.search(r"workspace\s*=\s*true", source):
        raise ValueError("unexpanded workspace inheritance")
    source = (
        "# Materialized from the exact upstream manifests; see bun-native/README.md.\n"
        + source
        + '\n# Isolate the vendored dependency from the Bun Native workspace.\n[workspace]\nresolver = "3"\n'
    )
    # Parse the generated TOML before it can become build input.
    tomllib.loads(source)
    return source


def verify(package):
    proof = package / "bun-native"
    receipt = json.loads((proof / "upstream.json").read_text())
    if receipt["repository"] != REPOSITORY or receipt["commit"] != REVISION:
        raise ValueError("unexpected upstream identity")
    if (
        receipt["package_tree"] != PACKAGE_TREE
        or git_tree(receipt["files"]) != PACKAGE_TREE
    ):
        raise ValueError("upstream package tree identity mismatch")
    if tuple(receipt["patches"]) != PATCHES:
        raise ValueError("unexpected patch inventory or order")
    original = (proof / "Cargo.toml.upstream").read_bytes()
    workspace = (proof / "workspace.toml.upstream").read_bytes()
    if (
        receipt["workspace_manifest_sha256"] != WORKSPACE_SHA256
        or sha256(workspace) != WORKSPACE_SHA256
    ):
        raise ValueError("upstream workspace manifest changed")
    expected_manifest = materialize_manifest(original.decode(), workspace.decode())
    if tomllib.loads((package / "Cargo.toml").read_text()) != tomllib.loads(
        expected_manifest
    ):
        raise ValueError(
            "standalone manifest differs from inherited upstream declarations"
        )

    expected_files = set(receipt["files"]) | {
        f"bun-native/{name}" for name in PROOF_FILES
    }
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

    # Reverse the exact reviewed patches in a disposable copy. The unmodified
    # sources must hash to the upstream blobs, so extra edits cannot hide in
    # an otherwise valid patch application. No shared checkout is ever edited.
    with tempfile.TemporaryDirectory(prefix="bun-native-wgpu-proof-") as temporary:
        root = Path(temporary)
        for name in PATCHED_FILES:
            destination = root / "wgpu-hal" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package / name, destination)
        for name, expected in reversed(list(receipt["patches"].items())):
            patch = proof / name
            if sha256(patch.read_bytes()) != expected:
                raise ValueError(f"reviewed patch changed: {name}")
            subprocess.run(
                ["git", "apply", "--reverse", str(patch.resolve())],
                cwd=root,
                capture_output=True,
                check=True,
                timeout=10,
            )
        for name, expected in receipt["files"].items():
            if name == "Cargo.toml":
                data = original
            elif name in PATCHED_FILES:
                data = (root / "wgpu-hal" / name).read_bytes()
            else:
                data = (package / name).read_bytes()
            blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
            if (
                len(data) != expected["bytes"]
                or sha256(data) != expected["sha256"]
                or blob != expected["git_blob"]
            ):
                raise ValueError(f"upstream source mismatch: {name}")
    return {
        "revision": REVISION,
        "upstream_files": len(receipt["files"]),
        "patches": list(receipt["patches"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--package",
        type=Path,
        default=ROOT / "native/vendor/wgpu-hal",
    )
    args = parser.parse_args()
    print(json.dumps(verify(args.package.resolve())))

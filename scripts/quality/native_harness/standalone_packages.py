"""Shared helpers for the installed-consumer CLI harness (tests/native/cli-standalone.py).

The fixed #382 cohort runner that used to live here is retired; see it at
https://github.com/0xPlayerOne/bun-native/blob/3f0713c/scripts/quality/standalone-packages.py.
`installed_inventory` stays a deliberately independent Python oracle for the CLI's
own verifyInstalledPackages (scripts/native/package-set.ts), including the
installer's `.bun-tag` format, so a bug in one is not mirrored in the other.
"""

import base64
import hashlib
import json
import os
import re
import stat
import subprocess
from pathlib import Path

from . import standalone_package_evidence as EVIDENCE
from .common import ROOT

# The pinned Linux x64 Bun executable identity has one source: toolchain.json.
TOOLCHAIN = json.loads((ROOT / "toolchain.json").read_text(encoding="utf-8"))
BUN_DIGEST = TOOLCHAIN["bun"]["packages"]["linux-x64"]["executable"]
COHORT_ERRORS = (
    OSError,
    RuntimeError,
    ValueError,
    KeyError,
    TypeError,
    subprocess.SubprocessError,
    KeyboardInterrupt,
)


require = EVIDENCE.require
digest = EVIDENCE.digest


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def missing_registry_cache_failure(exit_code, stderr, packages):
    """A cache negative must not hide an invalid-lock fallback or another error."""
    message = re.sub(r"\x1b\[[0-9;]*m", "", stderr)
    if exit_code != 1 or "InvalidLockfile" in message or "Ignoring lockfile" in message:
        return False
    identities = {entry[0] for entry in packages.values()}
    names = {identity.rsplit("@", 1)[0] for identity in identities}
    missing = set()
    resolutions = []
    for line in message.splitlines():
        if not line.startswith("error:"):
            continue
        match = re.fullmatch(
            r'error: --offline: no cached manifest for "([^"]+)" \(run once online, or use --prefer-offline\)',
            line,
        )
        if match and match[1] in names:
            missing.add(match[1])
            continue
        match = re.fullmatch(r'error: --offline: "([^"]+)" is not in the cache', line)
        if match and match[1] in names:
            missing.add(match[1])
            continue
        match = re.fullmatch(r"error: (\S+) failed to resolve", line)
        if match and match[1] in identities:
            resolutions.append(match[1].rsplit("@", 1)[0])
            continue
        return False
    return bool(missing) and all(name in missing for name in resolutions)


def inventory(directory):
    """Record files and original links without following directory symlinks."""
    result = {}
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in sorted(directories + files):
            path = Path(parent) / name
            key = path.relative_to(directory).as_posix()
            if path.is_symlink():
                result[key] = {"link": os.readlink(path)}
            elif path.is_file():
                result[key] = digest(path)
            else:
                require(path.is_dir(), f"Unsupported inventory entry: {path}")
    return dict(sorted(result.items()))


def git(repository, *args):
    return subprocess.check_output(
        ["git", "-C", str(repository), *args], timeout=10
    ).decode()


def source_snapshot(repository):
    require(
        not git(repository, "status", "--porcelain", "--untracked-files=all"),
        "Source must be clean",
    )
    paths = git(repository, "ls-files", "-z").split("\0")[:-1]
    files = {}
    for name in sorted(paths):
        path = repository / name
        require(
            stat.S_ISREG(path.lstat().st_mode), f"Source is not a regular file: {name}"
        )
        files[name] = digest(path)
    return {
        "commit": git(repository, "rev-parse", "HEAD").strip(),
        "tree": git(repository, "rev-parse", "HEAD^{tree}").strip(),
        "files": files,
    }


def installed_inventory(project, package_set):
    """Check all present local sources before executing an installed CLI module."""
    modules = (project / "node_modules").resolve(strict=True)
    require(modules.is_relative_to(project), "node_modules escapes the consumer")
    checked = []
    for name, pkg in package_set["packages"].items():
        location = modules / name
        if not location.exists():
            continue  # Overrides do not install the other framework's adapter.
        location = location.resolve(strict=True)
        require(location.is_relative_to(modules), f"Installed package escapes: {name}")
        require(
            not any(".bun-tag" in path.split("/") for path in pkg["files"]),
            f"Source archive contains reserved installer metadata: {name}",
        )
        # da867 Integrity::Display appends two '=' bytes after unpadded SHA256
        # base64. Keep this exact installer format distinct from the lock SRI.
        tag = (
            b"sha256-"
            + base64.b64encode(bytes.fromhex(pkg["archive"]["sha256"])).rstrip(b"=")
            + b"=="
        )
        expected = {
            **pkg["files"],
            ".bun-tag": {"bytes": len(tag), "sha256": hashlib.sha256(tag).hexdigest()},
        }
        folders = {
            "/".join(parts[:index])
            for path in expected
            for parts in [path.split("/")]
            for index in range(1, len(parts))
        }
        for parent, directories, _ in os.walk(location, followlinks=False):
            for folder in directories:
                path = Path(parent) / folder
                require(
                    path.relative_to(location).as_posix() in folders,
                    f"Installed package directory inventory differs: {name}",
                )
        actual = inventory(location)
        require(actual == expected, f"Installed package inventory differs: {name}")
        checked.append(name)
    require("@bun-native/cli" in checked, "Installed CLI is missing")
    links = []
    for parent, directories, files in os.walk(modules, followlinks=False):
        for name in directories + files:
            path = Path(parent) / name
            if path.is_symlink():
                require(
                    path.resolve(strict=True).is_relative_to(project),
                    f"Installed link escapes: {path}",
                )
                links.append(
                    {
                        "path": str(path.relative_to(project)),
                        "target": os.readlink(path),
                    }
                )
    return {"validated_local_packages": sorted(checked), "contained_links": links}

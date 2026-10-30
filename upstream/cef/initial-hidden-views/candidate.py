#!/usr/bin/env python3
"""Apply and verify the pinned, unqualified CEF initial-visibility candidate.

This tool never downloads, builds, loads native code, changes runtime pins, or
reports native acceptance. Binary identity input must come from Bunly's bounded
exported-API probe of independently trusted bytes; it is not build attestation.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
HASH = re.compile(r"[0-9a-f]{64}")
COMMIT = re.compile(r"[0-9a-f]{40}")
VARIANTS = ("baseline", "candidate")
# Contributor Release libraries may retain symbols. Hash without buffering them.
MAX_LIBRARY_BYTES = 8 * 1024**3


class CandidateError(ValueError):
    """A fixed, public validation failure."""


def require(condition, message):
    if not condition:
        raise CandidateError(message)


def scan_file(path, maximum, collect=False):
    path = Path(path)
    before = path.lstat()
    require(
        stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum,
        "Expected a bounded regular file, not a symbolic link",
    )
    keys = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")

    def same(info):
        return all(getattr(before, key) == getattr(info, key) for key in keys)

    digest = hashlib.sha256()
    chunks = []
    count = 0
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as source:
        require(same(os.fstat(source.fileno())), "File changed before opening")
        while chunk := source.read(1024 * 1024):
            count += len(chunk)
            require(count <= maximum, "File exceeds its bound during reading")
            digest.update(chunk)
            if collect:
                chunks.append(chunk)
        require(
            same(os.fstat(source.fileno())) and same(path.lstat()) and count == before.st_size,
            "File changed during verification",
        )
    return digest.hexdigest(), b"".join(chunks)


def digest_file(path, maximum=MAX_LIBRARY_BYTES):
    return scan_file(path, maximum)[0]


def read_json(path, maximum=128 * 1024):
    _, data = scan_file(path, maximum, collect=True)

    def unique_keys(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "Duplicate JSON key")
            value[key] = item
        return value

    return json.loads(data, object_pairs_hook=unique_keys)


def git(source, *args):
    result = subprocess.run(
        ["git", "--no-replace-objects", "-C", str(source), *args],
        capture_output=True,
        check=False,
        timeout=60,
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_NO_LAZY_FETCH": "1",
        },
    )
    require(result.returncode == 0, "Git verification or patch application failed")
    return result.stdout.decode("utf-8").strip()


def load_recipe(package=PACKAGE):
    recipe = read_json(package / "source.json")
    require(isinstance(recipe, dict), "Candidate recipe must be an object")
    require(recipe.get("schema") == 1, "Unsupported candidate recipe")
    require(
        recipe.get("status") == "source-candidate-unqualified",
        "Candidate must remain explicitly unqualified",
    )
    require(
        COMMIT.fullmatch(recipe.get("cefBaseCommit", "")) is not None
        and COMMIT.fullmatch(recipe.get("chromiumCommit", "")) is not None,
        "Invalid pinned source identity",
    )
    require(recipe.get("patchFormat") == "git-diff-unified-zero", "Wrong patch format")
    patches = recipe.get("patches")
    require(isinstance(patches, list) and len(patches) == 2, "Unexpected patch set")
    names = set()
    paths = set()
    for patch in patches:
        name = patch["file"]
        require(
            re.fullmatch(r"000[12]-[a-z-]+\.patch", name) is not None and name not in names,
            "Invalid patch name",
        )
        names.add(name)
        require(
            HASH.fullmatch(patch["sha256"]) is not None
            and digest_file(package / name, 1024 * 1024) == patch["sha256"],
            "Patch digest mismatch",
        )
        require(len(patch["paths"]) == 1, "Unexpected patch path set")
        for entry in patch["paths"]:
            path = entry["path"]
            require(
                not Path(path).is_absolute()
                and ".." not in Path(path).parts
                and "\\" not in path
                and path not in paths,
                "Invalid or duplicated source path",
            )
            paths.add(path)
            require(
                HASH.fullmatch(entry["beforeSha256"]) is not None
                and HASH.fullmatch(entry["afterSha256"]) is not None,
                "Invalid source file digest",
            )
    require(set(recipe["variants"]) == set(VARIANTS), "Unexpected variants")
    for variant, count in (("baseline", 1), ("candidate", 2)):
        value = recipe["variants"][variant]
        require(
            COMMIT.fullmatch(value["tree"]) is not None
            and value["patches"] == [patch["file"] for patch in patches[:count]],
            "Invalid candidate tree or patch order",
        )
    return recipe


def repository(source):
    source = Path(source).resolve(strict=True)
    require(
        Path(git(source, "rev-parse", "--show-toplevel")).resolve() == source,
        "Source must be the root of its CEF Git checkout",
    )
    return source


def verify_files(source, recipe, selected):
    selected = set(selected)
    for patch in recipe["patches"]:
        for entry in patch["paths"]:
            path = source / entry["path"]
            require(path.resolve().is_relative_to(source), "Source path escapes checkout")
            expected = entry["afterSha256" if patch["file"] in selected else "beforeSha256"]
            require(digest_file(path, 2 * 1024 * 1024) == expected, "Source digest mismatch")


def reject_hidden_index_entries(source):
    entries = git(source, "ls-files", "-v", "-z").split("\0")
    require(
        all(entry.startswith("H ") for entry in entries if entry),
        "Assume-unchanged or skip-worktree entries are not permitted",
    )


def verify_base(source, recipe):
    source = repository(source)
    reject_hidden_index_entries(source)
    require(
        git(source, "rev-parse", "HEAD") == recipe["cefBaseCommit"],
        "CEF checkout is not the exact pinned base commit",
    )
    require(
        not git(source, "status", "--porcelain=v1", "--untracked-files=all"),
        "Base checkout must have no staged, unstaged or untracked changes",
    )
    verify_files(source, recipe, ())
    return source


def patch_source(source, recipe, variant, apply=False, package=PACKAGE):
    source = verify_base(source, recipe)
    patches = [str(package / name) for name in recipe["variants"][variant]["patches"]]
    args = ("--index", "--unidiff-zero", "--whitespace=error", *patches)
    git(source, "apply", "--check", *args)
    if apply:
        git(source, "apply", *args)
        result = verify_source(source, recipe, variant)
        require(result["state"] == "staged", "Patch did not produce the expected index")
        return result
    return {
        "scope": "patch-applicability",
        "variant": variant,
        "baseCommit": recipe["cefBaseCommit"],
        "expectedTree": recipe["variants"][variant]["tree"],
        "nativeExecutionQualified": False,
    }


def verify_source(source, recipe, variant, require_commit=False):
    source = repository(source)
    reject_hidden_index_entries(source)
    expected = recipe["variants"][variant]
    head = git(source, "rev-parse", "HEAD")
    require(
        not git(source, "diff", "--no-ext-diff", "--name-only"),
        "Tracked worktree differs from the index",
    )
    require(
        git(source, "write-tree") == expected["tree"],
        "Tracked source tree is not the reviewed variant",
    )
    verify_files(source, recipe, expected["patches"])
    if head == recipe["cefBaseCommit"]:
        require(not require_commit, "Commit the reviewed candidate before building")
        require(
            not git(source, "ls-files", "--others", "--exclude-standard"),
            "Staged candidate contains untracked files",
        )
        state = "staged"
        commit = None
    else:
        parents = git(source, "rev-list", "--parents", "-n", "1", "HEAD").split()
        require(
            parents == [head, recipe["cefBaseCommit"]],
            "Candidate must be one commit directly on the pinned CEF base",
        )
        require(
            not git(source, "diff", "--cached", "--no-ext-diff", "--name-only")
            and git(source, "rev-parse", "HEAD^{tree}") == expected["tree"],
            "Committed candidate has staged changes",
        )
        state = "committed"
        commit = head
    return {
        "scope": "tracked-source",
        "variant": variant,
        "state": state,
        "baseCommit": recipe["cefBaseCommit"],
        "sourceCommit": commit,
        "tree": expected["tree"],
        "chromiumCommit": recipe["chromiumCommit"],
        "nativeExecutionQualified": False,
    }


def verify_exported_identity(identity, source_commit, expected_sha256, recipe):
    require(isinstance(identity, dict), "Exported identity must be an object")
    require(HASH.fullmatch(expected_sha256) is not None, "Pinned library digest required")
    require(
        expected_sha256 != recipe["baselineLinuxLibrarySha256"],
        "Stock CEF library is not the candidate",
    )
    require(
        identity.get("event") == "cef-binary-identity"
        and identity.get("schema") == 1
        and identity.get("source") == "exported-api"
        and identity.get("sha256") == expected_sha256,
        "Missing or inconsistent exported-API identity",
    )
    full = identity.get("fullVersion")
    require(isinstance(full, str) and len(full) <= 256, "Missing full CEF version")
    match = re.fullmatch(
        r"(?P<version>156\.[0-9]+\.[0-9]+)(?:-[0-9A-Za-z.-]+)?"
        r"\+g(?P<commit>[0-9a-f]{7,40})\+chromium-(?P<chromium>[0-9.]+)",
        full,
    )
    require(
        match is not None
        and source_commit.startswith(match["commit"])
        and match["commit"] != recipe["cefBaseCommit"][: len(match["commit"])]
        and match["version"] == identity.get("cefVersion")
        and match["chromium"] == recipe["chromiumVersion"]
        and identity.get("chromiumVersion") == recipe["chromiumVersion"],
        "Library version is not the exact candidate source and Chromium pair",
    )
    require(
        type(identity.get("cefCommitNumber")) is int and identity["cefCommitNumber"] > 0,
        "Invalid CEF commit number",
    )
    return full


def identity_from_observation(observation):
    require(isinstance(observation, dict), "Probe observation must be an object")
    require(
        observation.get("schema") == 1
        and type(observation.get("exitCode")) is int
        and observation["exitCode"] == 0
        and observation.get("timedOut") is False
        and observation.get("cancelled") is False
        and observation.get("outputOverflow") is False
        and "observerFailure" in observation
        and observation["observerFailure"] is None
        and observation.get("cleanupSurvivors") == []
        and observation.get("observedOrphans") == [],
        "Identity probe observation did not complete cleanly",
    )
    cleanup = observation.get("postExitCleanup")
    require(
        cleanup is None or (isinstance(cleanup, dict) and cleanup.get("passed") is True),
        "Identity probe post-exit cleanup failed",
    )
    reports = observation.get("reports")
    require(
        isinstance(reports, list) and len(reports) == 1 and isinstance(reports[0], dict),
        "Expected exactly one exported identity report",
    )
    return reports[0]


def verify_linkage(cargo_output, cef_dir, expected_sha256):
    cef_dir = Path(cef_dir).resolve(strict=True)
    _, output = scan_file(cargo_output, 4 * 1024 * 1024, collect=True)
    prefix = "cargo::metadata=CEF_DIR="
    paths = [
        line[len(prefix) :]
        for line in output.decode("utf-8").splitlines()
        if line.startswith(prefix)
    ]
    require(
        len(paths) == 1 and Path(paths[0]).resolve(strict=True) == cef_dir,
        "Cargo resolved a different CEF directory or stock fallback",
    )
    require(
        digest_file(cef_dir / "libcef.so") == expected_sha256,
        "Cargo-resolved CEF library differs from the candidate",
    )


def verify_binary(
    source,
    recipe,
    library,
    observation_path,
    expected_sha256,
    cargo_output=None,
    cef_dir=None,
):
    result = verify_source(source, recipe, "candidate", require_commit=True)
    require(
        digest_file(library) == expected_sha256,
        "Selected application library digest mismatch",
    )
    identity = identity_from_observation(read_json(observation_path, 16 * 1024 * 1024))
    full = verify_exported_identity(identity, result["sourceCommit"], expected_sha256, recipe)
    require(
        (cargo_output is None) == (cef_dir is None),
        "Cargo output and explicit CEF directory must be provided together",
    )
    if cargo_output is not None:
        verify_linkage(cargo_output, cef_dir, expected_sha256)
    return {
        **result,
        "scope": "candidate-binary-identity",
        "librarySha256": expected_sha256,
        "fullVersion": full,
        "cargoDirectoryVerified": cargo_output is not None,
        "sandbox": "unverified",
        "buildAttestation": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("check-patch", "apply", "check-source"):
        command = sub.add_parser(name)
        command.add_argument("--cef-source", required=True, type=Path)
        command.add_argument("--variant", choices=VARIANTS, default="candidate")
        if name == "check-source":
            command.add_argument("--require-commit", action="store_true")
    binary = sub.add_parser("check-binary")
    binary.add_argument("--cef-source", required=True, type=Path)
    binary.add_argument("--library", required=True, type=Path)
    binary.add_argument("--observation-json", required=True, type=Path)
    binary.add_argument("--sha256", required=True)
    binary.add_argument("--cargo-output", type=Path)
    binary.add_argument("--cef-dir", type=Path)
    args = parser.parse_args()
    recipe = load_recipe()
    if args.command in ("check-patch", "apply"):
        result = patch_source(args.cef_source, recipe, args.variant, apply=args.command == "apply")
    elif args.command == "check-source":
        result = verify_source(args.cef_source, recipe, args.variant, args.require_commit)
    else:
        result = verify_binary(
            args.cef_source,
            recipe,
            args.library,
            args.observation_json,
            args.sha256,
            args.cargo_output,
            args.cef_dir,
        )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (
        CandidateError,
        OSError,
        subprocess.SubprocessError,
        KeyError,
        TypeError,
        ValueError,
    ) as error:
        # Paths, loader messages, environment and arbitrary subprocess output
        # are not exported into the public candidate receipt.
        message = str(error) if isinstance(error, CandidateError) else type(error).__name__
        print(
            json.dumps(
                {
                    "scope": "candidate-verification-failure",
                    "error": message,
                    "nativeExecutionQualified": False,
                }
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None

"""Measure local ad-hoc signing separately from build, verification and compression.

Only copies of explicit Bunly benchmark apps under .bunly are modified. No key,
certificate selection, timestamp service, trust-store change or release upload.
This is NOT Developer ID, notarization or a distributable-release attestation.
"""

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from native_signing import native_command
from native_signing_policy import SigningError, snapshot
from reference_archive import create as archive_create
from reference_archive import verify as archive_verify

ROOT = Path(__file__).resolve().parents[1]
MACHO = {
    bytes.fromhex(v)
    for v in (
        "feedface",
        "feedfacf",
        "cefaedfe",
        "cffaedfe",
        "cafebabe",
        "bebafeca",
        "cafebabf",
        "bfbafeca",
    )
}


def targets(app):
    """Explicit inside-out list; links are validated by snapshot, never followed here."""
    snapshot(app)
    files, bundles = [], [app]
    for base, dirs, names in os.walk(app, followlinks=False):
        for name in dirs:
            path = Path(base) / name
            if not path.is_symlink() and path.suffix in (".app", ".framework"):
                bundles.append(path)
        for name in names:
            path = Path(base) / name
            if path.is_symlink():
                continue
            with path.open("rb") as source:
                if source.read(4) in MACHO:
                    files.append(path)
    if not files or len(files) + len(bundles) > 256:
        raise SigningError("invalid-local-signing-target-count")

    def order(path):
        return (-len(path.relative_to(app).parts), path.relative_to(app).as_posix())

    return sorted(files, key=order) + sorted(bundles, key=order)


def sign_command(path):
    return [
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        "--preserve-metadata=identifier,entitlements,flags",
        str(path),
    ]


def validate_metadata(text):
    if not re.search(r"(?m)^Signature=adhoc$", text):
        raise SigningError("expected-explicit-ad-hoc-signature")
    if re.search(r"(?m)^(Authority|Timestamp)=", text):
        raise SigningError("unexpected-identity-or-timestamp")


def inputs(source, output, expected, root=ROOT):
    source, output = Path(source).absolute(), Path(output).absolute()
    if source.is_symlink() or not source.is_dir() or source.suffix != ".app":
        raise SigningError("explicit-unlinked-app-required")
    scope = (root / ".bunly").resolve(strict=True)
    source, output = source.resolve(strict=True), output.resolve()
    if not source.is_relative_to(scope) or not output.is_relative_to(scope):
        raise SigningError("private-benchmark-workspace-required")
    if output == scope or output.is_relative_to(source) or source.is_relative_to(output):
        raise SigningError("overlapping-signing-workspace")
    if output.exists():
        raise SigningError("signing-output-already-exists")
    if re.fullmatch(r"[0-9a-f]{64}", expected) is None:
        raise SigningError("source-inventory-pin-required")
    plist = source / "Contents/Info.plist"
    if plist.is_symlink() or plist.stat().st_size > 1024 * 1024:
        raise SigningError("invalid-local-app-plist")
    identifier = plistlib.loads(plist.read_bytes()).get("CFBundleIdentifier", "")
    if not isinstance(identifier, str) or not identifier.startswith("dev.bunly."):
        raise SigningError("not-a-bunly-benchmark-app")
    before = snapshot(source)
    if before["sha256"] != expected:
        raise SigningError("source-inventory-mismatch")
    return source, output, before


def source_identity():
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    changes = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout
    return {"commit": commit, "clean": not changes.strip()}


def measure(source, output, expected, repetitions=3, warmups=1):
    if sys.platform != "darwin":
        raise SigningError("local-adhoc-profile-requires-macos")
    if (
        type(repetitions) is not int
        or not 1 <= repetitions <= 10
        or type(warmups) is not int
        or not 0 <= warmups <= 3
    ):
        raise SigningError("invalid-local-signing-trial-plan")
    source, output, before = inputs(source, output, expected)
    native_command(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(source)])
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    report = {
        "schema": 1,
        "profile": "local-ad-hoc-re-signing-of-prebuilt-benchmark",
        "source": source_identity(),
        "sourceArtifact": before,
        "plan": {"repetitions": repetitions, "warmups": warmups},
        "trials": [],
        "passed": False,
        "productionSigning": "skipped-by-user-no-apple-developer-account",
        "limitations": [
            "Local ad-hoc signatures, no identity or release approval",
            "Copying an already built app is not app-assembly timing",
            "Local observations, not controlled cross-framework performance",
            "Signing metadata preserved; no application execution claimed",
        ],
    }
    try:
        for warmup, count in ((True, warmups), (False, repetitions)):
            for trial in range(count):
                directory = output / f"{'warmup' if warmup else 'trial'}-{trial}"
                directory.mkdir(mode=0o700)
                app = directory / source.name
                row = {"warmup": warmup, "trial": trial, "passed": False}
                report["trials"].append(row)
                started = time.monotonic()
                shutil.copytree(source, app, symlinks=True, copy_function=shutil.copy2)
                row["copyMs"] = (time.monotonic() - started) * 1000
                if snapshot(app) != before:
                    raise SigningError("copied-app-inventory-mismatch")
                plan = targets(app)
                row["targets"] = [p.relative_to(app).as_posix() for p in plan]
                row["targetsSha256"] = hashlib.sha256(
                    json.dumps(row["targets"]).encode()
                ).hexdigest()
                started = time.monotonic()
                for path in plan:
                    native_command(sign_command(path))
                row["signCommandsMs"] = (time.monotonic() - started) * 1000
                signed = snapshot(app)
                started = time.monotonic()
                for path in plan:
                    native_command(["/usr/bin/codesign", "--verify", "--strict", str(path)])
                    out, err = native_command(
                        ["/usr/bin/codesign", "--display", "--verbose=4", str(path)]
                    )
                    validate_metadata(out + err)
                native_command(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])
                row["verifyCommandsMs"] = (time.monotonic() - started) * 1000
                if snapshot(app) != signed:
                    raise SigningError("signed-app-mutated-during-verification")
                row["signedArtifact"] = signed
                archive = directory / "app.tar.gz"
                started = time.monotonic()
                archive_create(app, archive)
                row["compressionMs"] = (time.monotonic() - started) * 1000
                started = time.monotonic()
                row["verifiedArchiveMembers"] = archive_verify(app, archive)
                row["archiveVerifyMs"] = (time.monotonic() - started) * 1000
                row["installerBytes"] = archive.stat().st_size
                with archive.open("rb") as payload:
                    digest = hashlib.sha256()
                    while chunk := payload.read(65536):
                        digest.update(chunk)
                    row["installerSha256"] = digest.hexdigest()
                # Deliberately mutate only the throwaway copy AFTER recording/compressing it.
                resource = app / "Contents/Info.plist"
                original = resource.read_bytes()
                try:
                    resource.write_bytes(original + b"\n<!-- intentional fixture mutation -->\n")
                    try:
                        native_command(
                            ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)]
                        )
                    except SigningError:
                        row["tamperRejected"] = True
                    else:
                        raise SigningError("native-verifier-accepted-tamper")
                finally:
                    resource.write_bytes(original)
                native_command(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])
                if snapshot(app) != signed or snapshot(source) != before:
                    raise SigningError("restored-copy-or-source-changed")
                row["passed"] = True
                print(
                    json.dumps(
                        {
                            "trial": trial,
                            "warmup": warmup,
                            "passed": True,
                            "signCommandsMs": row["signCommandsMs"],
                            "targets": len(plan),
                        }
                    ),
                    flush=True,
                )
                (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        report["sourceAfter"] = source_identity()
        report["sourceArtifactUnchanged"] = snapshot(source) == before
        report["passed"] = (
            report["sourceArtifactUnchanged"]
            and len(report["trials"]) == repetitions + warmups
            and all(t["passed"] for t in report["trials"])
        )
    except (SigningError, OSError, ValueError, subprocess.SubprocessError) as error:
        report["failure"] = str(error) if isinstance(error, SigningError) else type(error).__name__
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--source-inventory-sha256", required=True)
    args = parser.parse_args()
    result = measure(args.source, args.output, args.source_inventory_sha256)
    print(json.dumps({"passed": result["passed"], "profile": result["profile"]}))
    raise SystemExit(0 if result["passed"] else 1)

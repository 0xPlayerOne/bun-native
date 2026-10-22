"""Opt-in native signing for M2 release plans. Never imports keys or changes trust.

macOS uses codesign; Windows uses an explicitly pinned SDK SignTool and a
separate Authenticode verifier. Linux is unsupported, not an ad-hoc substitute.
The benchmark workspace and operating-system toolchain must be trusted.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import threading
import time
from pathlib import Path, PurePosixPath

from native_signing_policy import (
    MAX_JSON,
    RECEIPT,
    SigningError,
    contained,
    hex_value,
    load_policy,
    pairs,
    read_json,
    relative_name,
    snapshot,
    validate_policy,
)

STAGES = frozenset(
    (
        "cold-install",
        "warm-dev-launch",
        "frontend-edit",
        "backend-edit",
        "app-assembly",
        "release-sign",
        "installer-compress",
        "first-run",
        "update",
    )
)
SIGNING_SCRIPT = Path(__file__).resolve()


def native_command(args):
    """Bounded captured output; the outer M2 observer owns descendant cancellation."""
    child = subprocess.Popen(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()

    def drain(stream, buffer):
        try:
            while data := stream.read(16384):
                if len(buffer) + len(data) > MAX_JSON:
                    overflow.set()
                    child.kill()
                    break
                buffer.extend(data)
        finally:
            stream.close()

    readers = [
        threading.Thread(target=drain, args=(stream, buffer), daemon=True)
        for stream, buffer in zip((child.stdout, child.stderr), buffers, strict=False)
    ]
    for reader in readers:
        reader.start()
    try:
        child.wait(timeout=120)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=2)
    if overflow.is_set() or any(reader.is_alive() for reader in readers):
        raise SigningError("signing-tool-output-limit")
    if child.returncode != 0:
        raise SigningError("native-signing-tool-failed")
    return tuple(bytes(buffer).decode("utf-8", "strict") for buffer in buffers)


def requirement(policy, target):
    value = (
        'anchor apple generic and certificate leaf = H"'
        + policy["certificateSha1"]
        + '" and certificate leaf[subject.OU] = "'
        + policy["teamId"]
        + '"'
    )
    if target["path"] == policy["artifact"]:
        value += ' and identifier "' + policy["bundleIdentifier"] + '"'
    return value


def mac_sign_command(policy, target, path, workspace):
    args = [
        "/usr/bin/codesign",
        "--force",
        "--sign",
        policy["certificateSha1"],
        "--timestamp",
        "--options",
        "runtime",
    ]
    if "entitlements" in target:
        args += ["--entitlements", str(contained(workspace, target["entitlements"]["path"]))]
    return args + [str(path)]


def windows_sign_command(policy, path):
    return [
        policy["signtool"]["path"],
        "sign",
        "/s",
        "My",
        "/sha1",
        policy["certificateSha1"],
        "/fd",
        "SHA256",
        "/tr",
        policy["timestampUrl"],
        "/td",
        "SHA256",
        str(path),
    ]


def mac_metadata(text, policy):
    if "Signature=adhoc" in text or not re.search(r"(?m)^Timestamp=\S.+$", text):
        raise SigningError("timestamped-certificate-signature-required")
    if not re.search(r"(?m)^TeamIdentifier=" + re.escape(policy["teamId"]) + r"$", text):
        raise SigningError("wrong-mac-team")
    if not re.search(r"(?m)^CodeDirectory .+flags=0x[0-9a-fA-F]+\([^)]*\bruntime\b", text):
        raise SigningError("hardened-runtime-missing")


def windows_metadata(text, policy):
    try:
        value = json.loads(text, object_pairs_hook=pairs)
    except (ValueError, TypeError) as error:
        raise SigningError("invalid-authenticode-result") from error
    if (
        not isinstance(value, dict)
        or value.get("status") != "Valid"
        or value.get("type") != "Authenticode"
        or value.get("timestamped") is not True
    ):
        raise SigningError("valid-timestamped-authenticode-required")
    if (
        not isinstance(value.get("thumbprint"), str)
        or value["thumbprint"].upper() != policy["certificateSha1"].upper()
    ):
        raise SigningError("wrong-authenticode-signer")


def validate_app_bundle(workspace, name, expected_identifier=None):
    plist = contained(workspace, name + "/Contents/Info.plist")
    if not plist.is_file() or plist.stat().st_size > MAX_JSON:
        raise SigningError("invalid-app-plist")
    value = plistlib.loads(plist.read_bytes())
    if not isinstance(value, dict) or (
        expected_identifier is not None and value.get("CFBundleIdentifier") != expected_identifier
    ):
        raise SigningError("wrong-app-bundle-id")
    executable = value.get("CFBundleExecutable")
    if (
        not isinstance(executable, str)
        or relative_name(executable) != PurePosixPath(executable).name
    ):
        raise SigningError("invalid-bundle-executable")
    binary = contained(workspace, name + "/Contents/MacOS/" + executable)
    if not binary.is_file() or binary.stat().st_nlink != 1:
        raise SigningError("invalid-bundle-executable")


def preflight(policy, workspace):
    if sys.platform != policy["platform"]:
        raise SigningError("unsupported-signing-platform")
    artifact = contained(workspace, policy["artifact"])
    if policy["platform"] == "darwin":
        if not Path("/usr/bin/codesign").is_file() or not artifact.is_dir():
            raise SigningError("mac-signing-prerequisite")
        validate_app_bundle(workspace, policy["artifact"], policy["bundleIdentifier"])
    else:
        tool = Path(policy["signtool"]["path"])
        if not tool.is_file() or tool.is_symlink() or tool.stat().st_size > 128 * 1024 * 1024:
            raise SigningError("signtool-unavailable")
        if hashlib.sha256(tool.read_bytes()).hexdigest() != policy["signtool"]["sha256"].lower():
            raise SigningError("signtool-hash-mismatch")
    for target in policy["targets"]:
        path = contained(workspace, target["path"])
        if policy["platform"] == "darwin" and path.is_dir():
            if path.suffix == ".app":
                validate_app_bundle(workspace, target["path"])
            elif path.suffix != ".framework":
                raise SigningError("unsupported-signing-directory")
        if policy["platform"] == "win32" and not path.is_file():
            raise SigningError("authenticode-file-required")
        if "entitlements" in target:
            info = target["entitlements"]
            file = contained(workspace, info["path"])
            if (
                not file.is_file()
                or file.stat().st_size > MAX_JSON
                or hashlib.sha256(file.read_bytes()).hexdigest() != info["sha256"].lower()
            ):
                raise SigningError("entitlements-hash-mismatch")
            if not isinstance(plistlib.loads(file.read_bytes()), dict):
                raise SigningError("invalid-entitlements-plist")
    return artifact


def context():
    nonce, run_id = os.getenv("BUNLY_BENCH_NONCE"), os.getenv("BUNLY_BENCH_RUN_ID")
    if (
        os.getenv("BUNLY_BENCH_STAGE") != "release-sign"
        or not hex_value(nonce, 48)
        or not hex_value(run_id, 48)
    ):
        raise SigningError("release-sign-context-required")
    return {"nonce": nonce, "runId": run_id}


def verify_native(policy, workspace, run=native_command):
    for target in policy["targets"]:
        path = contained(workspace, target["path"])
        if policy["platform"] == "darwin":
            run(
                [
                    "/usr/bin/codesign",
                    "--verify",
                    "--deep",
                    "--strict",
                    "--verbose=2",
                    "-R=" + requirement(policy, target),
                    str(path),
                ]
            )
            stdout, stderr = run(["/usr/bin/codesign", "--display", "--verbose=4", str(path)])
            mac_metadata(stdout + stderr, policy)
        else:
            run([policy["signtool"]["path"], "verify", "/pa", "/all", "/tw", "/v", str(path)])
            powershell = (
                Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"  # noqa: SIM112 -- Windows-defined spelling
            )
            stdout, _ = run(
                [
                    str(powershell),
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(SIGNING_SCRIPT.with_name("verify_authenticode.ps1")),
                    "-Target",
                    str(path),
                ]
            )
            windows_metadata(stdout, policy)


def execute(action, workspace, policy_name, policy_hash):
    workspace = Path(workspace).resolve()
    policy = load_policy(workspace, policy_name, policy_hash)
    if action == "fresh":
        if os.getenv("BUNLY_BENCH_STAGE") != "app-assembly":
            raise SigningError("assembly-context-required")
        path = contained(workspace, policy["artifact"], exists=False)
        if path.exists():
            raise SigningError("assembly-artifact-already-exists")
        return {"event": "native-signing-freshness-checked"}
    ctx = context()
    artifact = preflight(policy, workspace)  # Refuse wrong platform before writing anything.
    receipt_path = contained(workspace, RECEIPT, exists=False)
    if receipt_path == artifact or receipt_path.is_relative_to(artifact):
        raise SigningError("receipt-inside-artifact")
    if action == "sign":
        if receipt_path.exists():
            raise SigningError("stale-signing-receipt")
        before = snapshot(artifact)
        started = time.monotonic()
        for target in policy["targets"]:
            path = contained(workspace, target["path"])
            args = (
                mac_sign_command(policy, target, path, workspace)
                if policy["platform"] == "darwin"
                else windows_sign_command(policy, path)
            )
            native_command(args)
        signing_ms = (time.monotonic() - started) * 1000
        after = snapshot(artifact)
        receipt = {
            "schema": 1,
            **ctx,
            "policySha256": policy_hash.lower(),
            "platform": policy["platform"],
            "before": before,
            "after": after,
            "targetCount": len(policy["targets"]),
            "signCommandsMs": signing_ms,
        }
        # Exclusive output: a previous trial cannot become this trial's receipt.
        fd = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(receipt, output, sort_keys=True)
        return {"event": "native-signing-applied", "targets": len(policy["targets"])}
    receipt, _ = read_json(receipt_path)
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema") != 1
        or any(receipt.get(k) != v for k, v in ctx.items())
        or receipt.get("policySha256") != policy_hash.lower()
        or receipt.get("platform") != policy["platform"]
        or receipt.get("targetCount") != len(policy["targets"])
    ):
        raise SigningError("stale-or-mismatched-signing-receipt")
    before = snapshot(artifact)
    if before != receipt.get("after"):
        raise SigningError("signed-artifact-changed")
    verify_native(policy, workspace)
    if snapshot(artifact) != before:
        raise SigningError("artifact-changed-during-verification")
    return {
        "event": "benchmark-verification",
        "stage": "release-sign",
        "nonce": ctx["nonce"],
        "passed": True,
        "evidence": f"Native signature verification for {len(policy['targets'])} explicit targets; pinned signer, timestamp and exact signed inventory. Not notarization, SmartScreen or runtime acceptance.",
    }


def attach(plan, policy, policy_name, policy_hash, interpreter, script=str(SIGNING_SCRIPT)):
    """Add a real signing stage; measure installed bytes after signing, not before."""
    policy = validate_policy(policy)
    relative_name(policy_name)
    if (
        not hex_value(policy_hash, 64)
        or not isinstance(plan, dict)
        or type(plan.get("schema")) is not int
        or plan.get("schema") != 1
    ):
        raise SigningError("invalid-signing-plan-input")
    result = copy.deepcopy(plan)
    tasks, unsupported = result.get("tasks"), result.get("unsupported")
    if (
        not isinstance(tasks, dict)
        or not isinstance(unsupported, dict)
        or set(tasks) & set(unsupported)
        or set(tasks) | set(unsupported) != STAGES
    ):
        raise SigningError("complete-stage-dispositions-required")
    if "release-sign" in tasks or "app-assembly" not in tasks:
        raise SigningError("unconfigured-signing-and-assembly-required")
    assembly = tasks["app-assembly"]
    installed = [o for o in assembly.get("outputs", []) if o.get("category") == "installed"]
    if len(installed) != 1 or installed[0].get("path") != policy["artifact"]:
        raise SigningError("signing-artifact-must-match-installed-boundary")
    if "release-sign" in assembly.get("dependsOn", []):
        raise SigningError("cyclic-signing-plan")
    assembly["outputs"] = [o for o in assembly["outputs"] if o.get("category") != "installed"]
    # Preserve the existing assembly freshness condition even though its size
    # measurement moves to the signing stage. No stale artifact can be reused.
    if installed[0].get("fresh") is True:
        assembly["commands"].insert(0, [interpreter, script, "fresh", policy_name, policy_hash])
    outputs = [{**installed[0], "fresh": False}]
    tasks["release-sign"] = {
        "dependsOn": ["app-assembly"],
        "commands": [[interpreter, script, "sign", policy_name, policy_hash]],
        "verify": [interpreter, script, "verify", policy_name, policy_hash],
        "outputs": outputs,
        "timeoutMs": 600000,
    }
    # Signing must see the actual user's configured keychain/store, not a synthetic
    # benchmark HOME. Never import a key into the benchmark's isolated home.
    del unsupported["release-sign"]
    for stage in ("installer-compress", "first-run", "update"):
        if stage in tasks and "release-sign" not in tasks[stage]["dependsOn"]:
            tasks[stage]["dependsOn"].append("release-sign")
    return result


def prepare(base, workspace, policy_file, expected_hash):
    """Copy only reviewed public policy/plists into an isolated signing directory."""
    workspace = Path(workspace).resolve()
    original_path = Path(policy_file).absolute()
    policy = load_policy(original_path.parent, original_path.name, expected_hash)
    # Validate the plan before writing any policy or entitlement files.
    attach(base, policy, ".benchmark-native-signing/policy.json", expected_hash, sys.executable)
    capsule = contained(workspace, ".benchmark-native-signing", exists=False)
    if capsule.exists():
        raise SigningError("signing-capsule-already-exists")
    entitlements = {}
    for target in policy["targets"]:
        if "entitlements" not in target:
            continue
        spec = target["entitlements"]
        source = contained(original_path.parent, spec["path"])
        if not source.is_file() or source.stat().st_size > MAX_JSON:
            raise SigningError("invalid-entitlement-file")
        data = source.read_bytes()
        actual = hashlib.sha256(data).hexdigest()
        if actual != spec["sha256"].lower() or not isinstance(plistlib.loads(data), dict):
            raise SigningError("entitlements-hash-mismatch")
        name = actual + ".plist"
        entitlements[name] = data
        target["entitlements"] = {"path": ".benchmark-native-signing/" + name, "sha256": actual}
    raw = (json.dumps(policy, indent=2) + "\n").encode()
    copied_hash = hashlib.sha256(raw).hexdigest()
    capsule.mkdir(mode=0o700)
    for name, data in {"policy.json": raw, **entitlements}.items():
        fd = os.open(capsule / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
    result = attach(
        base, policy, ".benchmark-native-signing/policy.json", copied_hash, sys.executable
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("sign", "verify", "fresh", "plan", "prepare"))
    parser.add_argument("policy")
    parser.add_argument("policy_sha256")
    parser.add_argument("--base-plan")
    parser.add_argument("--output")
    parser.add_argument("--workspace")
    args = parser.parse_args()
    try:
        if args.action in ("plan", "prepare"):
            if not args.base_plan or not args.output:
                raise SigningError("base-plan-and-output-required")
            base, _ = read_json(args.base_plan)
            if args.action == "prepare":
                if not args.workspace:
                    raise SigningError("workspace-required")
                result = prepare(base, args.workspace, args.policy, args.policy_sha256)
                path = contained(args.workspace, args.output, exists=False)
            else:
                policy = load_policy(Path.cwd(), args.policy, args.policy_sha256)
                result = attach(base, policy, args.policy, args.policy_sha256, sys.executable)
                path = contained(Path.cwd(), args.output, exists=False)
            # Plan creation never mutates an existing plan or installs anything.
            with path.open("x", encoding="utf-8") as output:
                json.dump(result, output, indent=2)
                output.write("\n")
            print(json.dumps({"event": "signing-plan-created"}))
        else:
            print(json.dumps(execute(args.action, Path.cwd(), args.policy, args.policy_sha256)))
        return 0
    except (
        SigningError,
        OSError,
        subprocess.SubprocessError,
        plistlib.InvalidFileException,
        UnicodeError,
    ) as error:
        print(
            json.dumps(
                {
                    "event": "native-signing-failed",
                    "code": str(error) if isinstance(error, SigningError) else type(error).__name__,
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

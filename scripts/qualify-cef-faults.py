"""Real native-process faults on a private prebuilt app; no process-name-wide termination."""

import argparse
import importlib.util
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import psutil
from cef_fault_acceptance import MODES, accept_fault
from cef_process_role import capture as helper_role
from qualify_adhoc_signing import targets

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location(
    "native_observer", ROOT / "scripts/observe-process.py"
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


def signed(app):
    for file in targets(app):
        subprocess.run(
            ["/usr/bin/codesign", "--force", "--sign", "-", str(file)],
            check=True,
            capture_output=True,
            timeout=20,
        )
    subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
        check=True,
        capture_output=True,
        timeout=20,
    )


def readiness(path, nonce, mode):
    """A fresh private marker follows real page readiness, not a guessed startup delay."""
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            return False
        value = json.loads(path.read_text())
        return (
            set(value) == {"mode", "nonce", "pid"}
            and value["nonce"] == nonce
            and value["mode"] == mode
            and type(value["pid"]) is int
            and value["pid"] > 0
        )
    except (OSError, ValueError, TypeError):
        return False


def snapshot(bun, artifact):
    completed = subprocess.run(
        [bun, str(ROOT / "scripts/cef-fault-integrity.ts"), str(artifact)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    if len(completed.stdout) > 8 * 1024**2:
        raise ValueError("Native fault snapshot exceeded bound")
    return json.loads(completed.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("app", type=Path)
    parser.add_argument("--bun", required=True)
    parser.add_argument("--emulated-functional", action="store_true")
    args = parser.parse_args()
    if sys.platform not in ("darwin", "linux", "win32"):
        raise SystemExit("Unsupported native-fault platform")
    mac = sys.platform == "darwin"
    parent = ROOT / ".bunly/m3/faults"
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    source = args.app.absolute()
    if source.is_symlink():
        raise ValueError("Prebuilt entry must not be a symbolic link")
    source = source.resolve(strict=True)
    input_root = source if mac else source.parent
    before = snapshot(args.bun, input_root)
    if before["source"]["clean"] is not True:
        raise ValueError("Native fault acceptance requires clean committed source")
    app = work / ("Fault.app" if mac else "Fault Unicode é Ω")
    shutil.copytree(source if mac else source.parent, app, symlinks=True)
    binary = app / "Contents/MacOS/bunly_host" if mac else app / source.name
    helper_root = app / "Contents/Frameworks" if mac else app
    application = app / ("Contents/Resources" if mac else "resources") / "backend/application.js"
    config_path = application.parent.parent / "runtime.json"
    config = json.loads(config_path.read_text())
    if "qualification_profile" in config:
        raise ValueError("Source prebuild already has a qualification profile")
    if args.emulated_functional:
        config["qualification_profile"] = "emulated-functional"
        config_path.write_text(json.dumps(config))
        os.environ["BUNLY_TEST_PAGE_TIMEOUT_MS"] = "60000"
    result = subprocess.run(
        [
            args.bun,
            "build",
            str(ROOT / "examples/cef/fault.ts"),
            "--target=bun",
            "--format=esm",
            "--outfile",
            str(application),
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    if mac:
        signed(app)
    prepared = snapshot(args.bun, app)
    reports = []
    for mode in MODES:
        os.environ["BUNLY_CEF_FAULT"] = mode
        os.environ["BUNLY_CACHE_DIR"] = str(work / (mode + "-profile"))
        nonce = secrets.token_hex(24)
        ready_path = work / (mode + ".ready.json")
        injected_path = work / (mode + ".injected.json")
        os.environ["BUNLY_CEF_FAULT_READY"] = str(ready_path)
        os.environ["BUNLY_CEF_FAULT_INJECTED"] = str(injected_path)
        os.environ["BUNLY_CEF_FAULT_NONCE"] = nonce
        injected = []
        root_identity = []

        def sample(
            pid,
            mode=mode,
            injected=injected,
            root_identity=root_identity,
            ready_path=ready_path,
            injected_path=injected_path,
            nonce=nonce,
        ):
            try:
                process = psutil.Process(pid)
                if (
                    not root_identity
                    and Path(process.exe()).resolve() == binary
                    and not any(arg.startswith("--type=") for arg in process.cmdline())
                ):
                    root_identity.append((pid, process.create_time()))
                if (
                    mode not in ("backend-exit", "backend-tree-exit")
                    and not injected
                    and root_identity
                    and readiness(ready_path, nonce, mode)
                ):
                    expected = "renderer" if mode == "renderer-exit" else "gpu-process"
                    executable = Path(process.exe()).resolve()
                    if executable.is_relative_to(helper_root):
                        identity = process.create_time()
                        evidence = helper_role(process)
                        if evidence is not None and evidence["role"] == expected:
                            owner = psutil.Process(root_identity[0][0])
                            if (
                                owner.create_time() == root_identity[0][1]
                                and any(
                                    child.pid == pid for child in owner.children(recursive=True)
                                )
                                and process.create_time() == identity
                            ):
                                injected.append(
                                    {
                                        "pid": pid,
                                        "creationTime": identity,
                                        "role": expected,
                                        "roleEvidence": evidence,
                                    }
                                )
                                process.kill()
                                with injected_path.open("x", encoding="utf-8") as receipt:
                                    json.dump(
                                        {
                                            "mode": mode,
                                            "nonce": nonce,
                                            "pid": pid,
                                            "creationTime": identity,
                                            "role": expected,
                                        },
                                        receipt,
                                    )
            except (psutil.Error, OSError):
                pass
            return {
                "provider": "private-fault-observation",
                "status": "unavailable",
                "reason": "not kernel measurement",
                "counters": [],
                "expectedScopes": 0,
                "sampledScopes": 0,
            }

        data = observer.observe(
            [str(binary)], timeout=300 if args.emulated_functional else 25, counter_reader=sample
        )
        trial = {"mode": mode, "passed": False, "injected": injected, "observation": data}
        try:
            trial["acceptance"] = accept_fault(mode, data, injected)
            trial["passed"] = True
        except (ValueError, KeyError, TypeError) as error:
            trial["failure"] = str(error)
        passed = trial["passed"]
        reports.append(trial)
        print(
            json.dumps(
                {
                    "mode": mode,
                    "passed": passed,
                    "exitCode": data["exitCode"],
                    "injected": injected,
                    "diagnostics": data["stderr"][-4:],
                }
            ),
            flush=True,
        )
    after = snapshot(args.bun, input_root)
    prepared_after = snapshot(args.bun, app)
    stable = (
        before["source"] == prepared["source"] == after["source"] == prepared_after["source"]
        and before["hashes"] == prepared["hashes"] == after["hashes"] == prepared_after["hashes"]
        and before["artifact"] == after["artifact"]
        and prepared["artifact"] == prepared_after["artifact"]
    )
    helper_samples = {
        "verified": [
            t["mode"]
            for t in reports
            if t["observation"].get("postExitCleanup", {}).get("qualified") is True
        ],
        "unobserved": [
            t["mode"]
            for t in reports
            if t["observation"].get("postExitCleanup", {}).get("status") == "not-observed"
        ],
    }
    result = {
        "schema": 3,
        "sourceBefore": before["source"],
        "sourceAfter": after["source"],
        "sourceHashes": before["hashes"],
        "sourceHashesAfter": after["hashes"],
        "inputArtifact": before["artifact"],
        "preparedArtifact": prepared["artifact"],
        "inputArtifactUnchanged": before["artifact"] == after["artifact"],
        "preparedArtifactUnchanged": prepared["artifact"] == prepared_after["artifact"],
        "sourceAndArtifactsUnchanged": stable,
        "helperSamples": helper_samples,
        "profile": "real-native-private-process-faults",
        "platform": sys.platform,
        "deadlineProfile": "emulated-functional" if args.emulated_functional else "standard",
        "passed": stable
        and all(r["passed"] for r in reports)
        and (not mac or bool(helper_samples["verified"])),
        "trials": reports,
    }
    (work / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "report": str(work / "report.json")}), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

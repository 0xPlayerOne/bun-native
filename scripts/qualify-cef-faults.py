"""Real native-process faults on a private prebuilt app; no process-name-wide termination."""

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import suppress
from pathlib import Path

import psutil
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("app", type=Path)
    parser.add_argument("--bun", required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("This private native-fault execution profile requires macOS")
    parent = ROOT / ".bunly/m3/faults"
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    app = work / "Fault.app"
    shutil.copytree(args.app.resolve(strict=True), app, symlinks=True)
    binary = app / "Contents/MacOS/bunly_host"
    application = app / "Contents/Resources/backend/application.js"
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
    signed(app)
    reports = []
    for mode in ("backend-exit", "backend-tree-exit", "renderer-exit", "gpu-exit"):
        os.environ["BUNLY_CEF_FAULT"] = mode
        os.environ["BUNLY_CACHE_DIR"] = str(work / (mode + "-profile"))
        started = time.monotonic()
        injected = []
        root_identity = []

        def sample(pid, mode=mode, injected=injected, root_identity=root_identity, started=started):
            try:
                process = psutil.Process(pid)
                if (
                    pid not in [v[0] for v in root_identity]
                    and Path(process.exe()).resolve() == binary
                ):
                    root_identity.append((pid, process.create_time()))
                if (
                    mode not in ("backend-exit", "backend-tree-exit")
                    and not injected
                    and root_identity
                    and time.monotonic() - started > 1.5
                ):
                    expected = "renderer" if mode == "renderer-exit" else "gpu-process"
                    if "--type=" + expected in process.cmdline():
                        executable = Path(process.exe()).resolve()
                        if executable.is_relative_to(app / "Contents/Frameworks"):
                            owner = psutil.Process(root_identity[0][0])
                            if owner.create_time() == root_identity[0][1] and any(
                                child.pid == pid for child in owner.children(recursive=True)
                            ):
                                identity = process.create_time()
                                if process.create_time() == identity:
                                    injected.append(
                                        {"pid": pid, "creationTime": identity, "role": expected}
                                    )
                                    process.kill()
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

        data = observer.observe([str(binary)], timeout=25, counter_reader=sample)
        text = "\n".join(data["stderr"])
        clean = not any(
            data[k]
            for k in (
                "timedOut",
                "cancelled",
                "observedOrphans",
                "cleanupSurvivors",
                "outputOverflow",
            )
        )
        expected = (
            data["exitCode"] == 0 and "bunly.native.gpu-recovered" in text
            if mode == "gpu-exit"
            else data["exitCode"] == 1
            and (
                "Renderer process terminated" in text if mode == "renderer-exit" else "Bun" in text
            )
        )
        records = []
        for line in data["stderr"]:
            with suppress(ValueError):
                records.append(json.loads(line))
        ready = any(
            r.get("event") == "bunly.fault.ready" and r.get("mode") == mode
            for r in records
            if isinstance(r, dict)
        )
        actual_exit = mode not in ("backend-exit", "backend-tree-exit") or any(
            r.get("event") == "bunly.backend.exit"
            and r.get("code") == 23
            and r.get("forced") is False
            for r in records
            if isinstance(r, dict)
        )
        native_renderer_failure = mode != "renderer-exit" or (
            any(
                r.get("event") == "bunly.host.failure"
                and r.get("error") == "Renderer process terminated before native shutdown"
                for r in records
                if isinstance(r, dict)
            )
            and any(
                r.get("event") == "bunly.native.renderer-failure-observed"
                and r.get("passed") is True
                for r in records
                if isinstance(r, dict)
            )
        )
        orderly_exit = any(
            r.get("event") == "bunly.host.shutdown" and r.get("clean") is (mode == "gpu-exit")
            for r in records
            if isinstance(r, dict)
        )
        passed = (
            clean
            and orderly_exit
            and expected
            and ready
            and actual_exit
            and native_renderer_failure
            and (mode in ("backend-exit", "backend-tree-exit") or bool(injected))
        )
        reports.append({"mode": mode, "passed": passed, "injected": injected, "observation": data})
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
    result = {
        "schema": 1,
        "profile": "real-macos-private-process-faults",
        "passed": all(r["passed"] for r in reports),
        "trials": reports,
    }
    (work / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "report": str(work / "report.json")}), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

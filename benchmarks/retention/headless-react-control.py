"""Record fixed React workload observations over the headless protocol peer.

This isolates the real workload and public core from GPUI; it is not a native
rendering or performance comparison. The workload's assertions are unchanged.
"""

import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def valid_report(raw, mode, trial, revision, exit_code):
    observation = raw["retentionObservation"]
    expected_count, mounts = (10, 2) if mode == "development" else (1000, 100)
    workload = {
        "iterations": expected_count,
        "rotations": expected_count,
        "mounts": mounts,
        "rows": 32,
        "warmup": 20,
    }
    cleanup = dict.fromkeys(
        (
            "windows",
            "nodes",
            "callbacks",
            "queuedTransactions",
            "queuedCallbacks",
            "activeCallbacks",
            "serviceRequests",
        ),
        0,
    )
    for key in ("firstReachable", "stillReachable"):
        indexes = observation[key]
        if not isinstance(indexes, list) or any(
            type(index) is not int or not 0 <= index < mounts * 3 for index in indexes
        ):
            return False
    error = raw.get("error")
    disposition = (
        exit_code == 0
        and raw["status"] == "passed"
        and not observation["stillReachable"]
    ) or (
        exit_code != 0
        and raw["status"] == "failed"
        and isinstance(error, str)
        and "Disposed view/callback targets remain observable" in error
        and bool(observation["stillReachable"])
    )
    return bool(
        raw["bunRevision"] == revision
        and raw["adapter"] == "react"
        and raw["nonce"] == f"{mode}-{trial}"
        and raw["declaredMode"] == mode
        and raw["workload"] == workload
        and raw["cleanup"] == cleanup
        and observation["collectionCheckpoints"] == 2
        and observation["probesPerMount"] == 3
        and disposition
    )


def main():
    peer, module, binary, output = (Path(value).resolve() for value in sys.argv[1:5])
    trials = int(sys.argv[5])
    if not 1 <= trials <= 10:
        raise ValueError("Trial count must be in 1..10")
    output.mkdir(parents=True, exist_ok=False)
    revision = json.loads(Path("toolchain.json").read_text())["bun"]["revision"]
    plan = {
        "revision": revision,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "sha256": {
            "peer": digest(peer),
            "module": digest(module),
            "aot": digest(binary),
        },
        "trialsPerMode": trials,
        "ordering": "development then AOT on even trials; reverse on odd trials",
        "scope": "Actual React workload and headless public-core IPC, with no GPUI or paint calibration",
        "development": "DFG disabled; 10 iterations, 10 rotations, 2 mounts, 32 rows",
        "aot": "default JSC options; 1000 iterations, 1000 rotations, 100 mounts, 32 rows",
    }
    (output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    results = []
    invalid = 0
    for trial in range(trials):
        modes = ("development", "aot") if trial % 2 == 0 else ("aot", "development")
        for mode in modes:
            report = output / f"{trial:02}-{mode}.json"
            env = os.environ.copy()
            for key in (
                "BUN_JSC_useDFGJIT",
                "BUN_NATIVE_EVIDENCE_LOG",
                "BUN_NATIVE_EVIDENCE_NONCE",
            ):
                env.pop(key, None)
            if mode == "development":
                env["BUN_JSC_useDFGJIT"] = "0"
            command = ["bun", str(module)] if mode == "development" else [str(binary)]
            count = (
                ["--iterations", "10", "--rotations", "10", "--mounts", "2"]
                if mode == "development"
                else ["--iterations", "1000", "--rotations", "1000", "--mounts", "100"]
            )
            command += [
                "--host",
                str(peer),
                "--output",
                str(report),
                "--nonce",
                f"{mode}-{trial}",
                "--mode",
                mode,
                "--rows",
                "32",
                *count,
            ]
            try:
                child = subprocess.run(
                    command, env=env, capture_output=True, text=True, timeout=120
                )
                (output / f"{trial:02}-{mode}.stdout.txt").write_text(
                    child.stdout, encoding="utf-8"
                )
                (output / f"{trial:02}-{mode}.stderr.txt").write_text(
                    child.stderr, encoding="utf-8"
                )
                raw = json.loads(report.read_text()) if report.exists() else None
                observation = raw["retentionObservation"] if raw else None
                cleanup = raw["cleanup"] if raw else None
                valid = bool(
                    raw and valid_report(raw, mode, trial, revision, child.returncode)
                )
                result = {
                    "trial": trial,
                    "mode": mode,
                    "exit": child.returncode,
                    "valid": valid,
                    "status": raw["status"] if raw else None,
                    "retention": observation,
                    "cleanup": cleanup,
                }
            except (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                subprocess.TimeoutExpired,
            ) as error:
                valid = False
                result = {
                    "trial": trial,
                    "mode": mode,
                    "valid": False,
                    "error": str(error),
                }
            invalid += not valid
            results.append(result)
            (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
            print(json.dumps(result), flush=True)
    if invalid:
        raise SystemExit(
            f"{invalid} processes failed outside the retention observation or produced invalid reports"
        )


if __name__ == "__main__":
    main()

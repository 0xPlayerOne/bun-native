"""Run a fixed no-framework retention matrix; preserve each process result.

This is diagnostic evidence, not a replacement for the native workload oracle.
"""

import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if sys.argv[1] == "--prepare":
        archive = Path(sys.argv[2]).read_bytes()
        if (
            hashlib.sha256(archive).hexdigest()
            != "d4efd3fabbf3021eff9ae3185d38138f64f8540b3ebdf6029d0ff979af8825b0"
        ):
            raise ValueError("Unexpected archived control")
        original = b"import { generateHeapSnapshotForDebugging, heapStats, jscDescribe, gcAndSweep, releaseWeakRefs } from 'bun:jsc'"
        compatible = b"import * as jsc from 'bun:jsc'\nconst { heapStats, jscDescribe, gcAndSweep, releaseWeakRefs } = jsc\nconst generateHeapSnapshotForDebugging = Reflect.get(jsc, 'generateHeapSnapshotForDebugging') as () => unknown"
        if archive.count(original) != 1:
            raise ValueError("Unexpected control import")
        address_pattern = b"[0-9a-f]+"
        if archive.count(address_pattern) != 1:
            raise ValueError("Unexpected control address pattern")
        with Path(sys.argv[3]).open("xb") as output:
            output.write(
                archive.replace(original, compatible).replace(
                    address_pattern, b"[0-9a-fA-F]+"
                )
            )
        return
    source = Path(sys.argv[1]).resolve()
    binary = Path(sys.argv[2]).resolve()
    output = Path(sys.argv[3]).resolve()
    trials = int(sys.argv[4])
    if not 1 <= trials <= 10:
        raise ValueError("Trial count must be in 1..10")
    output.mkdir(parents=True, exist_ok=False)
    revision = json.loads(Path("toolchain.json").read_text())["bun"]["revision"]
    plan = {
        "sourceSha256": digest(source),
        "binarySha256": digest(binary),
        "bunRevision": subprocess.check_output(
            ["bun", "--revision"], text=True
        ).strip(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "trialsPerCell": trials,
        "cells": ["development-bun", "development-no-dfg-bun", "aot-bun", "aot-jsc"],
        "ordering": "reverse cell order on odd trials",
        "meaning": "No framework, native host or real workload; positive checkpoints are observations, not proof of cause.",
    }
    (output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    results = []
    failures = 0
    for trial in range(trials):
        cells = plan["cells"] if trial % 2 == 0 else list(reversed(plan["cells"]))
        for cell in cells:
            report = output / f"{trial:02}-{cell}.json"
            environment = os.environ.copy()
            environment.pop("BUN_JSC_useDFGJIT", None)
            if cell == "development-no-dfg-bun":
                environment["BUN_JSC_useDFGJIT"] = "0"
            executable = (
                [str(binary)] if cell.startswith("aot-") else ["bun", str(source)]
            )
            method = "jsc" if cell == "aot-jsc" else "bun"
            command = [*executable, str(report), method]
            try:
                run = subprocess.run(
                    command, env=environment, capture_output=True, text=True, timeout=90
                )
                (output / f"{trial:02}-{cell}.stdout.txt").write_text(
                    run.stdout, encoding="utf-8"
                )
                (output / f"{trial:02}-{cell}.stderr.txt").write_text(
                    run.stderr, encoding="utf-8"
                )
                record = json.loads(report.read_text()) if report.exists() else None
                ok = (
                    run.returncode == 0
                    and record is not None
                    and record["bunRevision"] == revision
                    and record["mounts"] == 100
                    and record["totalRowsDisposed"] == 3200
                    and record["queued"] == 0
                    and record["collectionMethod"] == method
                    and all(
                        isinstance(index, int) and 0 <= index < 300
                        for key in ("firstReachable", "stillReachable")
                        for index in record[key]
                    )
                )
                result = {
                    "trial": trial,
                    "cell": cell,
                    "exit": run.returncode,
                    "valid": ok,
                    "firstReachable": record["firstReachable"] if record else None,
                    "stillReachable": record["stillReachable"] if record else None,
                }
            except (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                subprocess.TimeoutExpired,
            ) as error:
                result = {
                    "trial": trial,
                    "cell": cell,
                    "valid": False,
                    "error": str(error),
                }
                ok = False
            failures += not ok
            results.append(result)
            (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
            print(json.dumps(result), flush=True)
    if failures:
        raise SystemExit(
            f"{failures} control processes failed or produced invalid reports"
        )


if __name__ == "__main__":
    main()

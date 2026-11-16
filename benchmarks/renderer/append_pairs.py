"""Compare renderer append and guard workloads using identified bundles."""

import hashlib
import json
import math
import os
import platform
import statistics
import subprocess
import sys
from pathlib import Path

SCENARIOS = ("text", "row", "move", "swap")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cpu_model():
    if sys.platform == "darwin":
        return subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
        ).strip()
    if sys.platform.startswith("linux"):
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    return os.environ.get("PROCESSOR_IDENTIFIER", platform.processor())


def valid_sample(kind, value):
    if kind == "append":
        return (
            value["rows"] == 4000
            and value["samples"] == 200
            and len(value["timingsMs"]) == 200
            and len(value["removalTimingsMs"]) == 200
            and all(
                isinstance(x, (float, int)) and math.isfinite(x) and x >= 0
                for x in value["timingsMs"] + value["removalTimingsMs"]
            )
            and isinstance(value["p50Ms"], (float, int))
            and math.isfinite(value["p50Ms"])
            and value["p50Ms"] > 0
            and isinstance(value["removalP50Ms"], (float, int))
            and math.isfinite(value["removalP50Ms"])
            and value["removalP50Ms"] > 0
        )
    results = value["results"]
    return (
        len(results) == len(SCENARIOS)
        and {x["scenario"] for x in results} == set(SCENARIOS)
        and all(
            x["rows"] == 1667
            and x["samples"] == 1000
            and isinstance(x["p50Ms"], (float, int))
            and math.isfinite(x["p50Ms"])
            and x["p50Ms"] > 0
            for x in results
        )
    )


def main():
    if len(sys.argv) != 5:
        raise ValueError("Expected Bun, build directory, output and source metadata")
    bun, root, output, metadata = (Path(value).resolve() for value in sys.argv[1:])
    suffix = ".exe" if sys.platform == "win32" else ""
    files = {
        (kind, side, mode): root
        / f"{kind}-{side}{'.js' if mode == 'dev' else '-aot' + suffix}"
        for kind in ("append", "guard")
        for side in ("baseline", "candidate")
        for mode in ("dev", "aot")
    }
    result = {
        "source": json.loads(metadata.read_text(encoding="utf-8")),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu": cpu_model(),
        "hashes": {"/".join(key): sha(path) for key, path in files.items()},
        "scope": "In-process fake NativeWindow; excludes core, native host, IPC and paint.",
        "pairs": [],
    }
    for trial in range(12):
        pair = {"trial": trial}
        for kind in ("append", "guard"):
            for mode in ("dev", "aot"):
                for side in (
                    ("baseline", "candidate")
                    if trial % 2 == 0
                    else ("candidate", "baseline")
                ):
                    path = files[kind, side, mode]
                    command = [str(bun), str(path)] if mode == "dev" else [str(path)]
                    command += ["4000", "200"] if kind == "append" else ["1667"]
                    run = subprocess.run(
                        command, check=True, capture_output=True, text=True, timeout=180
                    )
                    value = json.loads(run.stdout)
                    if not valid_sample(kind, value):
                        raise ValueError(f"Invalid {kind} sample")
                    pair[f"{kind}/{side}/{mode}"] = value
        result["pairs"].append(pair)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for mode in ("dev", "aot"):
        for scenario in ("append", "remove-tail", *SCENARIOS):
            ratios = []
            for pair in result["pairs"]:
                if scenario == "append":
                    a = pair[f"append/baseline/{mode}"]["p50Ms"]
                    b = pair[f"append/candidate/{mode}"]["p50Ms"]
                elif scenario == "remove-tail":
                    a = pair[f"append/baseline/{mode}"]["removalP50Ms"]
                    b = pair[f"append/candidate/{mode}"]["removalP50Ms"]
                else:
                    a = next(
                        x["p50Ms"]
                        for x in pair[f"guard/baseline/{mode}"]["results"]
                        if x["scenario"] == scenario
                    )
                    b = next(
                        x["p50Ms"]
                        for x in pair[f"guard/candidate/{mode}"]["results"]
                        if x["scenario"] == scenario
                    )
                ratios.append(b / a)
            print(
                f"{mode} {scenario}: median ratio {statistics.median(ratios):.4f}; wins {sum(x < 1 for x in ratios)}/{len(ratios)}"
            )


if __name__ == "__main__":
    main()

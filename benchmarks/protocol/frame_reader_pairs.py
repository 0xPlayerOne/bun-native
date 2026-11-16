"""Collect alternating release-reader samples from two identified executables."""

import hashlib
import json
import os
import platform
import re
import statistics
import subprocess
import sys
from pathlib import Path

CASES = ("small", "medium", "large", "fragmented")
ROW = re.compile(
    r"^(\w+) bytes=(\d+) samples=(\d+) median_ns=([0-9.]+) rounds=\[(.*)\]$"
)


def digest(path):
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


def parse(output, samples):
    rows = {}
    for line in output.splitlines():
        match = ROW.fullmatch(line)
        if not match:
            raise ValueError(f"Unexpected reader output: {line}")
        name, size, count, median, rounds = match.groups()
        values = [float(value) for value in rounds.split(", ")]
        if (
            name not in CASES
            or name in rows
            or int(count) != samples
            or len(values) != 7
        ):
            raise ValueError("Incomplete or duplicate reader samples")
        rows[name] = {
            "bytes": int(size),
            "median_ns": float(median),
            "rounds_ns": values,
        }
    if set(rows) != set(CASES):
        raise ValueError("Missing reader cases")
    return rows


def main():
    if len(sys.argv) != 5:
        raise ValueError(
            "Expected baseline binary, candidate binary, output and source metadata"
        )
    baseline, candidate, output, metadata = map(Path, sys.argv[1:])
    samples, trials = 10000, 20
    result = {
        "source": json.loads(metadata.read_text(encoding="utf-8")),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu": cpu_model(),
        "baseline_sha256": digest(baseline),
        "candidate_sha256": digest(candidate),
        "samples_per_round": samples,
        "trials": [],
        "scope": "In-memory command reader, including parsing and validation; no native UI or IPC.",
    }
    for trial in range(trials):
        pair = {"trial": trial}
        order = (("baseline", baseline), ("candidate", candidate))
        if trial % 2:
            order = tuple(reversed(order))
        for name, binary in order:
            completed = subprocess.run(
                [str(binary), str(samples)],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
            pair[name] = {
                "raw": completed.stdout,
                "cases": parse(completed.stdout, samples),
            }
        if any(
            pair["baseline"]["cases"][name]["bytes"]
            != pair["candidate"]["cases"][name]["bytes"]
            for name in CASES
        ):
            raise ValueError("Baseline and candidate frame sizes differ")
        result["trials"].append(pair)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for name in CASES:
        ratios = [
            p["candidate"]["cases"][name]["median_ns"]
            / p["baseline"]["cases"][name]["median_ns"]
            for p in result["trials"]
        ]
        print(
            f"{name}: median paired ratio {statistics.median(ratios):.4f}; wins {sum(v < 1 for v in ratios)}/{trials}"
        )


if __name__ == "__main__":
    main()

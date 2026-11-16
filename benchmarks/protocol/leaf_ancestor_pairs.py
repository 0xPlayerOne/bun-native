"""Collect alternating release preflight samples from identified binaries."""

import hashlib
import json
import platform
import statistics
import subprocess
import sys
from pathlib import Path

from frame_reader_pairs import cpu_model

CASES = ("depth1", "depth8", "depth32", "nonleaf", "reorder")


def parse(output):
    samples = {name: {} for name in CASES}
    for line in output.splitlines():
        name, trial, nanos = line.split(",")
        trial, nanos = int(trial), int(nanos)
        if (
            name not in samples
            or trial not in range(5, 35)
            or nanos <= 0
            or trial in samples[name]
        ):
            raise ValueError("Invalid or duplicate preflight sample")
        samples[name][trial] = nanos
    if any(set(rows) != set(range(5, 35)) for rows in samples.values()):
        raise ValueError("Incomplete preflight samples")
    return {name: [samples[name][i] for i in range(5, 35)] for name in CASES}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if len(sys.argv) != 5:
        raise ValueError("Expected baseline, candidate, output and source metadata")
    baseline, candidate, output, metadata = map(Path, sys.argv[1:])
    result = {
        "source": json.loads(metadata.read_text(encoding="utf-8")),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu": cpu_model(),
        "baselineSha256": sha(baseline),
        "candidateSha256": sha(candidate),
        "scope": "Release native tree preflight; no IPC, GUI or presentation",
        "pairs": [],
    }
    for trial in range(25):
        pair = {"trial": trial}
        order = (("baseline", baseline), ("candidate", candidate))
        if trial % 2:
            order = tuple(reversed(order))
        for name, binary in order:
            run = subprocess.run(
                [str(binary)], capture_output=True, text=True, check=True, timeout=60
            )
            pair[name] = parse(run.stdout)
        result["pairs"].append(pair)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for case in CASES:
        ratios = [
            statistics.median(pair["candidate"][case])
            / statistics.median(pair["baseline"][case])
            for pair in result["pairs"]
        ]
        print(
            f"{case}: median paired ratio {statistics.median(ratios):.4f}; wins {sum(x < 1 for x in ratios)}/25"
        )


if __name__ == "__main__":
    main()

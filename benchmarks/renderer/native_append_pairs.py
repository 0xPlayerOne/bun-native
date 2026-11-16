"""Collect source-bound native append pairs in an isolated X11 session."""

import hashlib
import json
import math
import os
import platform
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.quality.native_harness.bridge_pairs import run_owned


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if len(sys.argv) != 6:
        raise ValueError("Expected Bun, host, binaries, output and source metadata")
    bun, host, binaries, output, metadata = (
        Path(arg).resolve() for arg in sys.argv[1:]
    )
    output.mkdir()
    source = json.loads(metadata.read_text())
    result = {
        "status": "running",
        "source": source,
        "hostSha256": digest(host),
        "platform": platform.platform(),
        "uname": list(platform.uname()),
        "cpu": next(
            (
                line.split(":", 1)[1].strip()
                for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")
            ),
            "unavailable",
        )
        if Path("/proc/cpuinfo").exists()
        else platform.processor(),
        "loadBefore": os.getloadavg(),
        "scope": "384 rows; complete GPUI paint traversal with evidence I/O; not display presentation",
        "pairs": [],
    }
    paths = {
        (side, mode): binaries / f"{side}{'.js' if mode == 'dev' else '-aot'}"
        for side in ("baseline", "candidate")
        for mode in ("dev", "aot")
    }
    result["binarySha256"] = {
        "/".join(key): digest(path) for key, path in paths.items()
    }
    reference_tree = None
    renderer = None
    try:
        for trial in range(6):
            pair = {"trial": trial, "warmup": trial == 0, "runs": {}}
            result["pairs"].append(pair)
            for mode in ("dev", "aot") if trial % 2 == 0 else ("aot", "dev"):
                for side in (
                    ("baseline", "candidate")
                    if trial % 2 == 0
                    else ("candidate", "baseline")
                ):
                    label = f"{trial:02}-{mode}-{side}"
                    run_dir = output / label
                    nonce = f"native-append-{label}"
                    command = (
                        [str(bun), str(paths[side, mode])]
                        if mode == "dev"
                        else [str(paths[side, mode])]
                    )
                    command += [
                        str(host),
                        str(run_dir / "result.json"),
                        str(run_dir / "evidence.jsonl"),
                        nonce,
                    ]
                    supervision = run_owned(
                        command, Path.cwd(), run_dir, 180, expected_host=host
                    )
                    pair["runs"][f"{mode}/{side}"] = supervision
                    if supervision["status"] != "passed":
                        raise RuntimeError(f"Failed native launch: {label}")
                    observation = json.loads((run_dir / "result.json").read_text())
                    if (
                        observation["status"] != "passed"
                        or len(observation["timings"]) != 8
                    ):
                        raise ValueError(f"Incomplete observation: {label}")
                    if reference_tree is None:
                        reference_tree = observation["initialTree"]
                        renderer = {
                            k: v
                            for k, v in observation["renderer"].items()
                            if k != "nonce"
                        }
                    if observation["initialTree"] != reference_tree:
                        raise ValueError(f"Native initial tree changed: {label}")
                    if {
                        k: v for k, v in observation["renderer"].items() if k != "nonce"
                    } != renderer:
                        raise ValueError(f"Native renderer identity changed: {label}")
                    for row in observation["timings"]:
                        if not all(
                            isinstance(row[k], (float, int))
                            and math.isfinite(row[k])
                            and row[k] > 0
                            for k in ("ackMs", "paintObservedMs")
                        ):
                            raise ValueError(f"Invalid timing: {label}")
                    pair["runs"][f"{mode}/{side}"] = {
                        "status": "passed",
                        "result": str(run_dir / "result.json"),
                        "supervisor": str(run_dir / "supervisor.json"),
                        "medianAckMs": statistics.median(
                            row["ackMs"] for row in observation["timings"]
                        ),
                        "medianPaintObservedMs": statistics.median(
                            row["paintObservedMs"] for row in observation["timings"]
                        ),
                    }
                    (output / "summary.json").write_text(
                        json.dumps(result, indent=2) + "\n"
                    )
        result["renderer"] = renderer
        result["comparisons"] = {}
        for mode in ("dev", "aot"):
            for metric in ("medianAckMs", "medianPaintObservedMs"):
                ratios = [
                    p["runs"][f"{mode}/candidate"][metric]
                    / p["runs"][f"{mode}/baseline"][metric]
                    for p in result["pairs"]
                    if not p["warmup"]
                ]
                result["comparisons"][f"{mode}/{metric}"] = {
                    "pairedRatios": ratios,
                    "medianRatio": statistics.median(ratios),
                }
        result["status"] = "passed"
    except BaseException as error:
        result["status"] = "failed"
        result["error"] = repr(error)
        raise
    finally:
        result["loadAfter"] = os.getloadavg()
        (output / "summary.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()

"""Fixed fresh-process counterfactuals; retain failures rather than qualify them."""

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

root = Path(os.environ["GITHUB_WORKSPACE"])
output = Path(os.environ["RUNNER_TEMP"]) / "queue-owner-evidence"
output.mkdir()
originals = {
    path: (root / path).read_bytes()
    for path in [
        "tests/solid/renderer.test.ts",
        "packages/core/src/application.ts",
        "packages/renderer/src/root.ts",
        "packages/renderer/src/window-lifetime.ts",
        ".github/workflows/bun-native.yml",
        ".github/workflows/native-linux.yml",
        ".github/workflows/native-platforms.yml",
        ".github/workflows/codeql.yml",
        "bun.lock",
        "toolchain.json",
    ]
}
orders = [
    ["original", "dormant", "release-tail", "retain-tail"],
    ["retain-tail", "release-tail", "dormant", "original"],
]
plan = {
    "scope": "Diagnostic only; no Validation / Gate result or native GUI claim",
    "source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "bunRevision": subprocess.check_output(["bun", "--revision"], text=True).strip(),
    "orders": orders,
    "attemptsPerCell": 1,
    "sourceHashes": {
        path: hashlib.sha256(data).hexdigest() for path, data in originals.items()
    },
    "limits": "Original full source tests and unchanged two GC calls, zero survivors and test timeouts",
}
(output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
results = []
for block, order in enumerate(orders):
    for variant in order:
        directory = output / f"block-{block}-{variant}"
        directory.mkdir()
        env = dict(os.environ)
        env["BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR"] = str(directory)
        env["BUN_NATIVE_QUEUE_OWNER_VARIANT"] = variant
        env["BUN_NATIVE_QUEUE_OWNER_REPORT"] = str(directory / "observer.json")
        args = ["bun", "test"]
        if variant != "original":
            args.extend(["--preload", "./experiments/queue-owner/preload.ts"])
        args.append("tests")
        forced = False
        with (directory / "test.log").open("w") as log:
            process = subprocess.Popen(
                args, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT
            )
            try:
                code = process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                forced = True
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                code = process.wait(timeout=10)
        text = (directory / "test.log").read_text(errors="replace")
        reports = [
            json.loads(path.read_text())
            for path in directory.glob("solid-retention-*.json")
        ]
        result = {
            "block": block,
            "variant": variant,
            "exitCode": code,
            "forced": forced,
            "failures": [
                line for line in text.splitlines() if re.search(r"\(fail\)", line)
            ],
            "survivors": [
                [item["index"] for item in report["survivors"]] for report in reports
            ],
            "observer": json.loads((directory / "observer.json").read_text())
            if (directory / "observer.json").is_file()
            else None,
        }
        results.append(result)
        (output / "outcomes.json").write_text(json.dumps(results, indent=2) + "\n")
        print(json.dumps(result), flush=True)
        if variant != "original" and (
            result["observer"] is None
            or not any(x["eligible"] for x in result["observer"]["checkpoints"])
        ):
            raise RuntimeError(
                "Counterfactual did not observe a fulfilled idle queue; experiment is invalid"
            )
for path, data in originals.items():
    assert (root / path).read_bytes() == data, path

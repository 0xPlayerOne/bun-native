"""Fixed production-only revoker-scope counterfactual; never qualifies a gate."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

output = Path(os.environ["RUNNER_TEMP"]) / "window-release-scope"
output.mkdir()
source = Path("packages/renderer/src/window-lifetime.ts")
original = source.read_text()
old = """  return () => {
    lifetime.listeners.delete(registration)
    registration.listener = undefined
  }
}"""
assert original.count(old) == 1
factory = """function releaseRegistration(lifetime: Lifetime, registration: Registration): () => void {
  return () => {
    lifetime.listeners.delete(registration)
    registration.listener = undefined
  }
}

"""
marker = (
    "/** One completion observer per window; release clears the callback itself. */"
)
assert original.count(marker) == 1
candidate = original.replace(
    old, "  return releaseRegistration(lifetime, registration)\n}"
).replace(marker, factory + marker)
uncleared = candidate.replace(
    factory, factory.replace("    registration.listener = undefined\n", "")
)
assert uncleared != candidate
variants = {
    "original": original,
    "separate-scope": candidate,
    "uncleared-negative": uncleared,
}
order = [
    ["original", "separate-scope", "uncleared-negative"],
    ["uncleared-negative", "separate-scope", "original"],
]
test = Path("tests/solid/renderer.test.ts")
test_hash = hashlib.sha256(test.read_bytes()).hexdigest()
assert test_hash == "e0156a12d48b4a5d4636980bdbc03ba1817ea242cc7b7ff759ed3c7b2740e7ef"
plan = {
    "scope": "Research only: production revoker lexical ownership, never Validation / Gate",
    "sourceCommit": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True
    ).strip(),
    "sourceTestSha256": test_hash,
    "order": order,
    "attemptsPerVariant": 2,
    "sourceSha256": {
        name: hashlib.sha256(value.encode()).hexdigest()
        for name, value in variants.items()
    },
    "expected": {
        "original": "last Solid root remains observable",
        "separate-scope": "no retained Solid roots, all tests pass",
        "uncleared-negative": "existing retained-revoker ownership regression must fail",
    },
    "unchanged": "Original producer, zero-survivor assertion, two original GC checkpoints, default JIT, source test suite and all existing timeouts",
    "failurePolicy": "Retain every outcome, including contrary observations; no retries or runtime pin changes",
}
(output / "plan.json").write_text(json.dumps(plan, indent=2))
outcomes = []
try:
    for block, names in enumerate(order, 1):
        for name in names:
            directory = output / f"{block:02d}-{name}"
            directory.mkdir()
            source.write_text(variants[name])
            (directory / "window-lifetime.ts.txt").write_text(variants[name])
            assert hashlib.sha256(test.read_bytes()).hexdigest() == test_hash
            environment = dict(os.environ)
            assert not any(key.startswith("BUN_JSC_") for key in environment)
            environment["BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR"] = str(directory)
            with (directory / "test.log").open("w") as log:
                result = subprocess.run(
                    ["bun", "test", "tests"],
                    env=environment,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=120,
                    check=False,
                )
            reports = [
                json.loads(path.read_text())
                for path in directory.glob("solid-retention-*.json")
            ]
            failures = [
                line
                for line in (directory / "test.log").read_text().splitlines()
                if "(fail)" in line
            ]
            outcome = {
                "block": block,
                "variant": name,
                "exitCode": result.returncode,
                "survivors": [report["survivors"] for report in reports],
                "failures": failures,
            }
            outcomes.append(outcome)
            (output / "outcomes.json").write_text(json.dumps(outcomes, indent=2))
            print(json.dumps(outcome), flush=True)
finally:
    source.write_text(original)
    assert hashlib.sha256(test.read_bytes()).hexdigest() == test_hash

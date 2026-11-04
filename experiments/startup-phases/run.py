"""Run the original native lifecycle once and preserve its unchanged result."""

import hashlib
import json
import os
import secrets
import signal
import subprocess
import time
from pathlib import Path

source = Path(os.environ["GITHUB_WORKSPACE"])
output = Path(os.environ["STARTUP_PHASE_EVIDENCE"])
plan = json.loads((output / "plan.json").read_text())
fixture = source / "tests/native/lifecycle.ts"
assert hashlib.sha256(fixture.read_bytes()).hexdigest() == plan["originalFixtureSha256"]
host = source / "target/release/bun-native-host"
identity = {
    "hostSha256": hashlib.sha256(host.read_bytes()).hexdigest(),
    "hostBytes": host.stat().st_size,
    "bunRevision": subprocess.check_output(["bun", "--revision"], text=True).strip(),
    "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(),
    "scope": "Real instrumented GPUI release host; original lifecycle and deadlines; not acceptance",
}
(output / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
environment = dict(os.environ)
environment.update(
    BUN_NATIVE_HOST=str(host),
    BUN_NATIVE_HOST_PROFILE="release",
    BUN_NATIVE_STARTUP_LOG="1",
    BUN_NATIVE_STARTUP_TRACE="1",
    BUN_NATIVE_EVIDENCE_LOG=str(output / "startup.jsonl"),
    BUN_NATIVE_EVIDENCE_NONCE=secrets.token_hex(16),
)
started = time.monotonic()
forced = False
with (output / "lifecycle.log").open("w") as log:
    process = subprocess.Popen(
        ["bun", "tests/native/lifecycle.ts"],
        cwd=source,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        code = process.wait(timeout=45)
    except subprocess.TimeoutExpired:
        forced = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait(timeout=5)
remaining_group = False
try:
    os.killpg(process.pid, 0)
    remaining_group = True
    os.killpg(process.pid, signal.SIGTERM)
    until = time.monotonic() + 5
    while time.monotonic() < until:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.killpg(process.pid, signal.SIGKILL)
except ProcessLookupError:
    pass
records = []
trace = output / "startup.jsonl"
if trace.exists():
    assert trace.stat().st_size <= 1048576, "Startup evidence exceeded bound"
    records = [json.loads(line) for line in trace.read_text().splitlines()]
phases = [
    {
        k: record[k]
        for k in [
            "source",
            "phase",
            "message",
            "elapsed_ns",
            "pid",
            "request_id",
            "window_id",
            "error",
        ]
        if k in record
    }
    for record in records
    if record.get("phase") != "log"
    or str(record.get("message", "")).startswith("BN_PHASE")
]
result = {
    "exitCode": code,
    "forced": forced,
    "remainingOwnedProcessGroup": remaining_group,
    "durationSeconds": time.monotonic() - started,
    "status": "passed"
    if code == 0 and not forced and not remaining_group
    else "failed",
    "phaseClockWarning": "Native and transport clocks are separately relative; do not subtract across processes",
    "phases": phases,
}
(output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
assert hashlib.sha256(fixture.read_bytes()).hexdigest() == plan["originalFixtureSha256"]
print(json.dumps(result, indent=2), flush=True)
raise SystemExit(0 if result["status"] == "passed" else 1)

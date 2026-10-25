"""Current native fault receipts. Expected failures are not clean application exits."""

import json
import math

from report_m3_acceptance import clean_process, require

MODES = ("backend-exit", "backend-tree-exit", "renderer-exit", "gpu-exit")
PHASES = ("process-stop", "host-release", "asset-service-stop", "cef-shutdown")


def positive_integer(value):
    return type(value) is int and 0 < value < 2**31


def finite_nonnegative(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def accept_fault(mode, observation, injections, *, require_output=True):
    require(mode in MODES, "Unknown fault mode")
    require(type(observation.get("exitCode")) is int, "Invalid native exit")
    clean_process(observation, 0 if mode == "gpu-exit" else 1)
    require(observation.get("observerFailure") is None, "Native observer failed")
    cleanup = observation.get("postExitCleanup")
    if cleanup is not None:
        require(
            isinstance(cleanup, dict) and cleanup.get("passed") is True, "Helper cleanup failed"
        )
    lines = observation.get("nativeDiagnostics")
    require(isinstance(lines, list) and 0 < len(lines) <= 128, "Missing bounded native receipts")
    require(
        all(isinstance(line, str) and len(line.encode()) <= 16384 for line in lines),
        "Invalid native receipt",
    )
    require(sum(len(line.encode()) for line in lines) <= 65536, "Native receipts exceed bound")
    records = [json.loads(line) for line in lines]
    require(
        all(isinstance(row, dict) and isinstance(row.get("event"), str) for row in records),
        "Malformed native receipt",
    )

    def matching(event):
        return [row for row in records if row["event"] == event]

    def exactly(event):
        rows = matching(event)
        require(len(rows) == 1, "Missing or duplicate " + event)
        return rows[0]

    ready = exactly("bunly.fault.ready")
    require(
        ready.get("mode") == mode and positive_integer(ready.get("pid")), "Wrong fault readiness"
    )
    phases = matching("bunly.host.shutdown-phase")
    require(
        [(row.get("phase"), row.get("state")) for row in phases]
        == [(phase, state) for phase in PHASES for state in ("start", "complete")],
        "Incomplete or reordered native shutdown",
    )
    for row in phases[1::2]:
        require(finite_nonnegative(row.get("durationMs")), "Invalid native shutdown duration")
    backend = exactly("bunly.backend.exit")
    require(
        backend.get("code") == (23 if mode.startswith("backend-") else 0)
        and backend.get("forced") is False
        and backend.get("pid") == ready["pid"],
        "Wrong or forced backend exit",
    )
    require(
        records.index(ready)
        < records.index(phases[0])
        < records.index(backend)
        < records.index(phases[1]),
        "Fault readiness/backend shutdown order is invalid",
    )
    shutdown = exactly("bunly.host.shutdown")
    require(shutdown.get("clean") is (mode == "gpu-exit"), "Wrong fault shutdown classification")
    require(
        records.index(shutdown) > records.index(phases[-1]), "Host completed before native teardown"
    )
    if require_output or matching("bunly.native.output-drained"):
        drained = exactly("bunly.native.output-drained")
        counters = ("frames", "ordinaryFrames", "retainedWireBytes", "ordinaryWireBytes")
        require(
            set(drained) == {"event", "schema", *counters} and drained["schema"] == 1,
            "Malformed output drain receipt",
        )
        require(
            all(type(drained[key]) is int and drained[key] == 0 for key in counters),
            "Native output reservations remain after writer completion",
        )
        require(
            records.index(backend) < records.index(drained) < records.index(phases[1]),
            "Output drain did not follow backend exit and writer join",
        )
    require(not matching("bunly.host.error"), "Startup failure is not fault acceptance")
    failures = [row.get("error") for row in matching("bunly.host.failure")]
    require(all(isinstance(value, str) for value in failures), "Malformed host failure")
    if mode.startswith("backend-"):
        require(
            1 <= len(failures) <= 2
            and len(set(failures)) == len(failures)
            and set(failures)
            <= {
                "Bun backend exited before native shutdown",
                "Bun backend process exited before native shutdown",
            },
            "Wrong backend failure diagnostic",
        )
        require(injections == [], "Backend case must not inject a browser fault")
    else:
        require(
            isinstance(injections, list) and len(injections) == 1, "Missing exact helper injection"
        )
        injection = injections[0]
        role = "gpu-process" if mode == "gpu-exit" else "renderer"
        require(
            isinstance(injection, dict)
            and injection.get("role") == role
            and positive_integer(injection.get("pid"))
            and finite_nonnegative(injection.get("creationTime"))
            and injection["creationTime"] > 0
            and isinstance(injection.get("roleEvidence"), dict)
            and injection["roleEvidence"].get("role") == role,
            "Wrong or unidentified helper injection",
        )
        if mode == "renderer-exit":
            require(
                failures == ["Renderer process terminated before native shutdown"],
                "Wrong renderer failure",
            )
            observed = exactly("bunly.native.renderer-failure-observed")
            require(
                observed.get("passed") is True
                and records.index(ready) < records.index(observed) < records.index(backend),
                "Renderer failure was not acknowledged",
            )
        else:
            require(failures == [], "Unexpected native failure during GPU recovery")
            acknowledged = exactly("bunly.native.gpu-injection-acknowledged")
            recovered = exactly("bunly.native.gpu-recovered")
            require(
                acknowledged.get("passed") is True
                and recovered.get("passed") is True
                and records.index(ready)
                < records.index(acknowledged)
                < records.index(recovered)
                < records.index(phases[0]),
                "GPU recovery did not follow actual injection",
            )
    descendants = matching("bunly.fault.descendant")
    if mode == "backend-tree-exit":
        require(
            len(descendants) == 1 and positive_integer(descendants[0].get("pid")),
            "Missing owned descendant",
        )
        pid = descendants[0]["pid"]
        require(pid != ready["pid"], "Descendant is the backend")
        require(
            any(
                row.get("pid") == pid
                and finite_nonnegative(row.get("creationTime"))
                and row["creationTime"] > 0
                for sample in observation.get("samples", [])
                for row in sample.get("processes", [])
            ),
            "Descendant cleanup lacks actual process observation",
        )
    else:
        require(descendants == [], "Unexpected descendant fixture")
    return {"mode": mode, "expectedApplicationFailure": mode != "gpu-exit", "orderedShutdown": True}

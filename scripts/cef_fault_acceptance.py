"""Current native fault receipts. Expected failures are not clean application exits."""

import json
import math

from report_m3_acceptance import clean_process, require

LEGACY_MODES = ("backend-exit", "backend-tree-exit", "renderer-exit", "gpu-exit")
MODES = (*LEGACY_MODES, "backend-shell-tree-exit", "backend-hang")
PHASES = ("process-stop", "host-release", "asset-service-stop", "cef-shutdown")


def positive_integer(value):
    return type(value) is int and 0 < value < 2**31


def finite_nonnegative(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def accept_fault(
    mode,
    observation,
    injections,
    *,
    require_output=True,
    require_renderer_identity=True,
    require_renderer_message=False,
    renderer_platform=None,
    require_renderer_handshake=False,
    require_failed_shutdown=False,
):
    require(mode in MODES, "Unknown fault mode")
    require(type(require_failed_shutdown) is bool, "Invalid failed-shutdown selection")
    require(
        not require_failed_shutdown or require_renderer_handshake,
        "Failed shutdown requires the exact native renderer handshake",
    )
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
    if mode == "backend-hang":
        require(
            backend.get("forced") is True
            and (
                backend.get("code") is None
                or type(backend.get("code")) is int
                and backend["code"] == 1
            )
            and backend.get("pid") == ready["pid"],
            "Blocked backend did not require owned forced termination",
        )
        blocked = exactly("bunly.fault.blocked")
        require(
            blocked
            == {
                "event": "bunly.fault.blocked",
                "mode": mode,
                "pid": ready["pid"],
                "quitRequested": True,
            },
            "Missing exact blocked-backend receipt",
        )
        require(
            records.index(ready) < records.index(blocked) < records.index(phases[0]),
            "Block/quit receipt order is invalid",
        )
        profile = exactly("bunly.runtime.profile")
        require(
            profile.get("profile") in ("standard", "emulated-functional"),
            "Unknown native grace profile",
        )
        grace_ms = 2000 if profile["profile"] == "standard" else 5000
        require(
            phases[1]["durationMs"] >= grace_ms,
            "Forced exit did not exercise the original grace deadline",
        )
    else:
        # Old retained fixtures predate the SDK's failed-shutdown rejection.
        # Current runs explicitly require the backend to propagate that failure.
        expected_backend_exit = (
            23
            if mode.startswith("backend-")
            else 1
            if mode == "renderer-exit" and require_failed_shutdown
            else 0
        )
        require(
            type(backend.get("code")) is int
            and backend.get("code") == expected_backend_exit
            and backend.get("forced") is False
            and backend.get("pid") == ready["pid"],
            "Wrong or forced backend exit",
        )
        require(not matching("bunly.fault.blocked"), "Unexpected blocked-backend receipt")
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
    if mode == "backend-hang":
        require(failures == [], "Unrelated failure is not hung-backend acceptance")
        require(injections == [], "Blocked backend must not inject a browser fault")
    elif mode.startswith("backend-"):
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
    elif mode == "renderer-exit" and (require_renderer_message or require_renderer_handshake):
        require(injections == [], "Native document fault must not also signal a guessed OS process")
        require(
            set(ready) == {"event", "mode", "pid"},
            "Unexpected namespace PID in native-task readiness",
        )
        injection = exactly("bunly.native.renderer-injected")
        require(
            injection
            == {
                "event": "bunly.native.renderer-injected",
                "schema": 2 if require_renderer_handshake else 1,
                "authority": "native-main-frame-handshake"
                if require_renderer_handshake
                else "native-main-frame-message",
                "exitCode": 86,
            }
            and type(injection.get("schema")) is int
            and type(injection.get("exitCode")) is int,
            "Missing exact native main-frame task injection",
        )
        require(
            failures == ["Renderer process terminated before native shutdown"],
            "Wrong renderer failure",
        )
        require(
            renderer_platform in ("darwin", "linux", "win32"), "Missing expected renderer platform"
        )
        observed = exactly("bunly.native.renderer-failure-observed")
        require(
            observed
            == {
                "event": "bunly.native.renderer-failure-observed",
                "passed": True,
                "exitCode": 86,
                "nativeErrorCode": 86 if renderer_platform == "win32" else 86 << 8,
                "platform": renderer_platform,
                **({"shutdownRejected": True} if require_failed_shutdown else {}),
            }
            and type(observed.get("exitCode")) is int
            and type(observed.get("nativeErrorCode")) is int
            and observed.get("passed") is True
            and (not require_failed_shutdown or observed.get("shutdownRejected") is True)
            and records.index(ready)
            < records.index(injection)
            < records.index(observed)
            < records.index(backend),
            "Actual renderer failure did not follow the native document injection",
        )
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
            if require_renderer_identity or "rendererPid" in ready:
                require(
                    positive_integer(ready.get("rendererPid"))
                    and ready["rendererPid"] != ready["pid"]
                    and injection["pid"] == ready["rendererPid"]
                    and injection.get("targetAuthority") == "native-main-frame",
                    "Renderer injection did not target the exact native main-frame process",
                )
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
    if not (mode == "renderer-exit" and (require_renderer_message or require_renderer_handshake)):
        require(
            not matching("bunly.native.renderer-injected"),
            "Unexpected native-task injection receipt",
        )
    if mode != "renderer-exit":
        require("rendererPid" not in ready, "Unexpected renderer proof in another fault mode")
    descendants = matching("bunly.fault.descendant")
    if mode == "backend-shell-tree-exit":
        require(len(descendants) == 2, "Missing shell/server descendant pair")
        shell, server = descendants
        require(
            shell.get("role") == "shell"
            and server.get("role") == "server"
            and positive_integer(shell.get("pid"))
            and positive_integer(server.get("pid"))
            and len({ready["pid"], shell["pid"], server["pid"]}) == 3
            and shell.get("parentPid") == ready["pid"]
            and server.get("parentPid") == shell["pid"],
            "Wrong shell/grandchild ownership chain",
        )
        identities = observation.get("descendantIdentities")
        require(
            isinstance(identities, list) and len(identities) == 2,
            "Missing independent descendant identities",
        )
        require(
            all(
                isinstance(row, dict)
                and set(row) == {"pid", "parentPid", "creationTime"}
                and positive_integer(row["pid"])
                and positive_integer(row["parentPid"])
                and finite_nonnegative(row["creationTime"])
                and row["creationTime"] > 0
                for row in identities
            ),
            "Malformed independent descendant identity",
        )
        require(
            len({row["pid"] for row in identities}) == 2,
            "Duplicate independent descendant identity",
        )
        for descendant in descendants:
            matching_identity = [
                row
                for row in identities
                if row["pid"] == descendant["pid"] and row["parentPid"] == descendant["parentPid"]
            ]
            require(len(matching_identity) == 1, "Wrong independently observed descendant ancestry")
            identity = matching_identity[0]
            require(
                any(
                    row.get("pid") == identity["pid"]
                    and row.get("creationTime") == identity["creationTime"]
                    for sample in observation.get("samples", [])
                    for row in sample.get("processes", [])
                ),
                "Descendant identity lacks actual process observation",
            )
        confirmed = exactly("bunly.fault.tree-observed")
        require(
            confirmed
            == {
                "event": "bunly.fault.tree-observed",
                "mode": mode,
                "count": 2,
                "serverResponded": True,
            },
            "Missing observed listening-server receipt",
        )
        require(
            records.index(ready)
            < records.index(shell)
            < records.index(server)
            < records.index(confirmed)
            < records.index(phases[0]),
            "Tree readiness did not precede backend failure",
        )
    elif mode == "backend-tree-exit":
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
    if mode != "backend-shell-tree-exit":
        require(
            not observation.get("descendantIdentities"), "Unexpected observed descendant identities"
        )
        require(not matching("bunly.fault.tree-observed"), "Unexpected tree observation")
    return {"mode": mode, "expectedApplicationFailure": mode != "gpu-exit", "orderedShutdown": True}

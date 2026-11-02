"""Clipboard assertions reused by the existing owned-process X11 diagnostic driver."""

from pathlib import Path
import time


OUTCOMES = {
    "nativeDefaultDenial",
    "nativeStaleAndUnknownOwners",
    "pendingShutdownJoined",
    "emptySelection",
    "stalledTransferDeadline",
    "inputAndCommitDuringTransfer",
    "ordinary",
    "delayed",
    "incremental",
    "empty-text",
    "oversize",
    "incr-oversize",
    "incr-header-large",
    "invalid-utf8",
    "nul",
    "drop",
    "slow-incr",
    "flood",
    "submittedReadCancellation",
    "preDispatchCancellation",
    "pendingWindowClose",
    "externalReadOfWrite",
    "malformedMultipleRejected",
    "externalEmptyText",
    "writeSurvivesWindowClose",
    "shutdownPreservesNewExternalOwner",
}
OWNERSHIP = {
    "windows",
    "nodes",
    "callbacks",
    "queuedTransactions",
    "queuedCallbacks",
    "activeCallbacks",
    "serviceRequests",
}
PEER_LABELS = {
    "shutdown",
    "responsive",
    "ordinary",
    "delayed",
    "incremental",
    "empty-text",
    "oversize",
    "incr-oversize",
    "incr-header-large",
    "invalid-utf8",
    "nul",
    "drop",
    "slow-incr",
    "flood",
    "cancelled",
    "closed-window",
    "read-written",
    "multiple-malformed",
    "read-empty",
    "read-after-close",
    "replacement",
    "read-after-shutdown",
}


def paint(revision, text, value=""):
    """Independent full model expectation, never a copy of the observed paint."""
    elements = [
        {
            "kind": "box",
            "style": {
                "direction": "column",
                "padding": 24,
                "gap": 12,
                "background": 0xF4F5F7,
            },
        },
        {
            "kind": "text",
            "text": "Bounded native clipboard",
            "style": {"height": 40, "font_size": 26},
        },
        {"kind": "text", "text": text, "style": {"height": 32}},
        {
            "kind": "input",
            "value": value,
            "placeholder": "Input remains responsive",
            "style": {"width": "fill", "height": 44, "font_size": 22},
        },
    ]
    nodes = [
        {
            "node_id": index + 1,
            "children": [2, 3, 4] if index == 0 else [],
            "element": element,
        }
        for index, element in enumerate(elements)
    ]
    nodes[-1]["input_revision"] = len(value)
    return {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": revision,
        "nodes": nodes,
    }


def thread_snapshot(pid):
    """Read only the already verified host's single named clipboard worker."""
    matches = []
    for path in Path(f"/proc/{pid}/task").iterdir():
        try:
            if (path / "comm").read_text().strip() == "bun-native-clip":
                matches.append(path)
        except FileNotFoundError:
            continue
    if len(matches) != 1:
        raise RuntimeError("Expected one owned native clipboard worker")
    path = matches[0]
    stat = (path / "stat").read_text()
    fields = stat[stat.rfind(")") + 2 :].split()
    status = dict(
        line.split(":", 1) for line in (path / "status").read_text().splitlines()
    )
    return {
        "tid": int(path.name),
        "startTicks": fields[19],
        "state": fields[0],
        "cpuTicks": int(fields[11]) + int(fields[12]),
        "voluntarySwitches": int(status["voluntary_ctxt_switches"].strip()),
        "involuntarySwitches": int(status["nonvoluntary_ctxt_switches"].strip()),
    }


def verify_idle(before, after):
    if (before["tid"], before["startTicks"]) != (after["tid"], after["startTicks"]):
        raise RuntimeError(
            "Native clipboard worker identity changed during idle observation"
        )
    cpu = after["cpuTicks"] - before["cpuTicks"]
    switches = after["voluntarySwitches"] - before["voluntarySwitches"]
    if (
        before["state"] != "S"
        or after["state"] != "S"
        or cpu != 0
        or not 0 <= switches <= 2
    ):
        raise RuntimeError(
            "Native clipboard worker did not remain asleep without periodic polling"
        )
    return {
        "cpuTicks": cpu,
        "voluntarySwitches": switches,
        "involuntarySwitches": after["involuntarySwitches"]
        - before["involuntarySwitches"],
    }


def validate_result(application):
    outcomes = application.get("outcomes")
    if (
        not isinstance(outcomes, dict)
        or set(outcomes) != OUTCOMES
        or not all(value is True for value in outcomes.values())
    ):
        raise RuntimeError(
            "Clipboard fixture did not prove every required native outcome"
        )
    ownership = application.get("ownership")
    if (
        not isinstance(ownership, dict)
        or set(ownership) != OWNERSHIP
        or not all(type(value) is int and value == 0 for value in ownership.values())
    ):
        raise RuntimeError("Clipboard fixture did not release every public owner")
    peers = application.get("peers")
    if (
        not isinstance(peers, list)
        or len(peers) != len(PEER_LABELS)
        or any(
            not isinstance(peer, dict)
            or type(peer.get("exitCode")) is not int
            or peer["exitCode"] != 0
            or not isinstance(peer.get("records"), list)
            or not peer["records"]
            for peer in peers
        )
        or {peer.get("label") for peer in peers} != PEER_LABELS
    ):
        raise RuntimeError(
            "Clipboard fixture did not join every independent foreground peer"
        )
    if type(application.get("inputCount")) is not int or application["inputCount"] != 1:
        raise RuntimeError(
            "Clipboard fixture did not observe exactly one OS input edit"
        )


def run(
    driver,
    geometry,
    window,
    output,
    native_records,
    application_records,
    wait_for,
    require_owned,
    capture,
):
    """Keep XTest input, paint and process cleanup in the existing driver."""
    observations = {
        "idle": {},
        "timingScope": "Command start to validated application-log observation; not presentation latency or a benchmark.",
    }

    def application(kind):
        return next(
            (row for row in application_records() if row.get("type") == kind), None
        )

    def painted(revision, text, value=""):
        expected = paint(revision, text, value)
        return next(
            (row for row in native_records() if driver.matches_paint(row, expected)),
            None,
        )

    wait_for(
        lambda: painted(1, "Clipboard ready"), "complete initial clipboard native paint"
    )

    def initial_layout():
        row = next(
            (
                row
                for row in reversed(native_records())
                if row.get("type") == "layout"
                and row.get("window_id") == 1
                and row.get("tree_revision") == 1
            ),
            None,
        )
        if not row or row.get("layout", {}).get("status") != "complete":
            return None
        layout = row["layout"]
        if (
            layout.get("node_count") != 4
            or len(layout.get("nodes", [])) != 4
            or layout.get("scale_factor") != 1
        ):
            raise RuntimeError(
                "Clipboard input requires complete scale-1 native geometry"
            )
        return layout

    layout = wait_for(initial_layout, "complete clipboard input geometry")
    require_owned()
    fields = dict(
        line.split("=", 1)
        for line in driver.run(
            ["xdotool", "getwindowgeometry", "--shell", window]
        ).splitlines()
        if "=" in line
    )
    if layout["viewport"] != [int(fields["WIDTH"]), int(fields["HEIGHT"])]:
        raise RuntimeError(
            "Clipboard native geometry differs from the owned client viewport"
        )
    input_node = next(node for node in layout["nodes"] if node["node_id"] == 4)
    x, y = geometry.pointer_point(
        input_node["bounds"], input_node["ancestor_clip"], layout["viewport"]
    )
    require_owned()
    driver.run(["xdotool", "mousemove", "--window", window, x, y, "click", "1"])

    def idle(stage):
        wait_for(lambda: application(stage + "-idle"), stage + " idle checkpoint")
        require_owned()
        pid = int(driver.run(["xdotool", "getwindowpid", window]))
        before = wait_for(
            lambda: (
                snapshot if (snapshot := thread_snapshot(pid))["state"] == "S" else None
            ),
            "sleeping clipboard worker",
        )
        started = time.monotonic()
        time.sleep(0.2)
        require_owned()
        if int(driver.run(["xdotool", "getwindowpid", window])) != pid:
            raise RuntimeError(
                "Clipboard native window owner changed during idle observation"
            )
        after = thread_snapshot(pid)
        observations["idle"][stage] = {
            "before": before,
            "after": after,
            "delta": verify_idle(before, after),
            "observedIntervalMs": (time.monotonic() - started) * 1000,
        }
        (output / ("after-" + stage + "-idle")).touch()

    idle("read")
    (output / "start-stall").touch()
    committed = wait_for(
        lambda: application("commit-during-transfer"),
        "tree commit during stalled selection",
    )
    if committed.get("pending") is not True or committed.get("treeRevision") != 2:
        raise RuntimeError(
            "Clipboard transfer did not remain pending through an ordinary tree commit"
        )
    wait_for(
        lambda: painted(2, "Input and updates continue"),
        "native paint during stalled selection",
    )
    require_owned()
    if driver.run(["xdotool", "getwindowfocus"]) != window:
        raise RuntimeError("Owned clipboard window lost focus before input")
    if application("stalled-transfer-rejected"):
        raise RuntimeError("Clipboard transfer already ended before OS input")
    injected = time.monotonic()
    driver.run(["xdotool", "type", "--clearmodifiers", "--delay", "0", "x"])
    injection_finished = time.monotonic()
    edited = wait_for(
        lambda: application("input-during-transfer"),
        "OS input while the external owner is stalled",
    )
    if (
        edited.get("pending") is not True
        or edited.get("value") != "x"
        or edited.get("revision") != 1
    ):
        raise RuntimeError(
            "Native input did not reach the public listener during the stalled transfer"
        )
    observations["input"] = {
        "event": edited,
        "injectionDurationMs": (injection_finished - injected) * 1000,
        "logObservedAfterInjectionMs": (time.monotonic() - injected) * 1000,
    }
    wait_for(
        lambda: painted(2, "Input and updates continue", "x"),
        "updated native editor paint during stalled selection",
    )
    if application("stalled-transfer-rejected"):
        raise RuntimeError(
            "Native editor paint was not observed before the stalled transfer ended"
        )
    observations["stalledTransfer"] = wait_for(
        lambda: application("stalled-transfer-rejected"),
        "bounded stalled-owner rejection",
    )
    idle("write")
    idle("lost-owner")
    completed = wait_for(
        lambda: application("completed"), "all clipboard scenarios before OS close"
    )
    if completed.get("treeRevision") != 3 or completed.get("input") != {
        "value": "x",
        "revision": 1,
    }:
        raise RuntimeError("Clipboard fixture lost the actual native edit state")
    final = paint(3, "Clipboard checks passed", "x")
    wait_for(
        lambda: painted(3, "Clipboard checks passed", "x"),
        "complete final clipboard tree and input paint",
    )
    observations["finalNativePaint"] = final
    capture(window, "after.png")
    require_owned()
    driver.run(["xdotool", "windowactivate", "--sync", window])
    if driver.run(["xdotool", "getwindowfocus"]) != window:
        raise RuntimeError("Owned clipboard window lost focus before OS close")
    driver.run(["xdotool", "key", "--clearmodifiers", "alt+F4"])
    return observations

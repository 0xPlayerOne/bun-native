"""Pinned CEF helper-role diagnostics for private native fault fixtures.

Linux forked children may retain --type=zygote in /proc cmdline. The observed
CEF 154 renderer/GPU thread signatures distinguish those children without
mistaking a zygote broker for a renderer. This is diagnostic evidence, never
process ownership or sandbox authorization. The caller must independently
verify executable, ancestry, PID creation time and the private readiness nonce.
"""

import sys
from pathlib import Path

MARKERS = {"Chrome_ChildIOT", "Compositor", "GpuWatchdog", "VizCompositorTh"}


def classify(arguments, thread_names=()):
    kinds = [arg[7:] for arg in arguments if arg.startswith("--type=")]
    if len(kinds) != 1:
        return None
    kind = kinds[0]
    if kind in ("renderer", "gpu-process"):
        return {"role": kind, "source": "explicit-process-argument", "argvRole": kind}
    if kind != "zygote":
        return None
    names = set(thread_names)
    if "Chrome_ChildIOT" not in names:
        return None
    gpu = {"GpuWatchdog", "VizCompositorTh"}.issubset(names)
    renderer = "Compositor" in names
    # Ambiguous or partial signatures fail closed instead of choosing a target.
    if gpu == renderer or (renderer and names & {"GpuWatchdog", "VizCompositorTh"}):
        return None
    return {
        "role": "gpu-process" if gpu else "renderer",
        "source": "pinned-linux-zygote-thread-signature",
        "argvRole": kind,
        "threadMarkers": sorted(names & MARKERS),
    }


def capture(process):
    arguments = process.cmdline()
    direct = classify(arguments)
    if direct is not None or sys.platform != "linux" or "--type=zygote" not in arguments:
        return direct
    paths = []
    # Bound discovery without materializing an arbitrary-sized task inventory.
    for task in Path(f"/proc/{process.pid}/task").iterdir():
        if task.name.isdecimal():
            paths.append(task / "comm")
            if len(paths) > 512:
                return None
    names = set()
    for path in paths:
        try:
            with path.open("rb") as stream:
                raw = stream.read(65)
            if len(raw) <= 64:
                names.add(raw.decode("ascii").strip())
        except (OSError, UnicodeError):
            # A partial inventory must not be interpreted as a complete signature.
            return None
    return classify(arguments, names)

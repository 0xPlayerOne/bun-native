#!/usr/bin/env python3
"""Run one React behavior case through the shared owned native input driver.

The application asserts hook/error identity and cleanup. This controller adds
actual OS activation, exact initial/final native trees, screenshots and process
ownership. Declaring AOT here does not inspect or prove the application artifact.
"""

import argparse
import json
import os
from pathlib import Path
import sys


SCENARIOS = (
    "lifecycle",
    "boundary-fallback",
    "boundary-recovery",
    "recoverable-retry",
    "throwing-reporter",
    "cleanup-effect",
    "cleanup-ref",
    "transition",
)
TERMINAL = ("throwing-reporter", "cleanup-effect", "cleanup-ref")


def tree(scenario, final):
    """Independent full-tree oracle; no application-supplied expected snapshot."""
    terminal = scenario in TERMINAL
    if final and terminal:
        return [
            {"node_id": 1, "element": {"kind": "box", "style": {}}, "children": [7]},
            {"node_id": 7, "element": {"kind": "box", "style": {}}, "children": [8]},
            {
                "node_id": 8,
                "element": {
                    "kind": "text",
                    "text": f"Survivor after {scenario}",
                    "style": {"height": 28},
                },
                "children": [],
            },
        ]
    label = (
        f"State {2 if final else 0} / Reducer {2 if final else 0}"
        if scenario == "lifecycle"
        else ("Fallback" if final else "Healthy 0")
        if scenario == "boundary-fallback"
        else ("Healthy 1" if final else "Fallback")
        if scenario == "boundary-recovery"
        else f"State {1 if scenario == 'transition' else 2}"
        if final
        else "State 0"
    )
    label_id = 7 if final and scenario.startswith("boundary-") else 5
    elements = {
        1: {"kind": "box", "style": {}},
        2: {"kind": "box", "style": {}},
        3: {"kind": "box", "style": {"direction": "column", "padding": 24, "gap": 12}},
        4: {
            "kind": "text",
            "text": "React behavior",
            "style": {"height": 32, "font_size": 24},
        },
        label_id: {"kind": "text", "text": label, "style": {"height": 28}},
        6: {
            "kind": "button",
            "text": "Run behavior",
            "disabled": False,
            "style": {"width": 240, "height": 44},
        },
    }
    children = {1: [2], 2: [3], 3: [4, label_id, 6]}
    if terminal:
        children[1].append(7)
        children[7] = [8]
        elements[7] = {"kind": "box", "style": {}}
        elements[8] = {
            "kind": "text",
            "text": "Survivor ready",
            "style": {"height": 28},
        }
    return [
        {
            "node_id": identity,
            "element": element,
            "children": children.get(identity, []),
        }
        for identity, element in sorted(elements.items())
    ]


def expectations(scenario):
    if scenario not in SCENARIOS:
        raise ValueError("Unknown React behavior scenario")
    base = {"type": "rendered", "stage": "native-paint", "window_id": 1}
    initial = {
        **base,
        "tree_revision": 2 if scenario in TERMINAL else 1,
        "nodes": tree(scenario, False),
    }
    final = {**base, "nodes": tree(scenario, True)}
    if scenario not in TERMINAL:
        final["tree_revision"] = 3 if scenario == "recoverable-retry" else 2
    # A terminal reporter may fail before or after a staged retry reaches the
    # host. Its final exact tree must contain only the independently usable
    # survivor; the observed native revision is retained without a false count.
    event = {
        "type": "click",
        "stage": "bun-application",
        "scenario": scenario,
        "qualified": True,
        "terminalRejected": scenario in TERMINAL,
        "boundaryErrors": 1 if scenario.startswith("boundary-") else 0,
        "recoveredErrors": 1
        if scenario in ("recoverable-retry", "throwing-reporter")
        else 0,
    }
    return initial, final, event


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=SCENARIOS, required=True)
    parser.add_argument("--mode", choices=["development", "aot"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("supply the application command after --")
    initial, final, event = expectations(args.scenario)
    os.environ["BUN_NATIVE_REACT_BEHAVIOR"] = args.scenario
    driver = (
        Path(__file__).resolve().parents[2] / "scripts/quality/native-input-linux.py"
    )
    arguments = [
        sys.executable,
        str(driver),
        "--output",
        str(args.output),
        "--mode",
        args.mode,
        "--title",
        "Bun Native React Behavior",
        "--timeout",
        "30",
        "--expect-software-renderer",
        "--expect-initial-render",
        json.dumps(initial),
        "--expect-render",
        json.dumps(final),
        "--expect-event",
        json.dumps(event),
        "--click",
        "100",
        "130",
    ]
    os.execv(sys.executable, [*arguments, "--", *command])


if __name__ == "__main__":
    main()

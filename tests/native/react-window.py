#!/usr/bin/env python3
"""Independent expected native trees for the real React counter fixture.

Run inside native-linux-session.sh. Exec the common owned input driver so this
fixture adds no second process/window supervisor or simulated input path.
"""

import argparse
import json
import os
from pathlib import Path
import sys


def nodes(clicks, value):
    elements = [
        {"kind": "box", "style": {}},
        {"kind": "box", "style": {}},
        {
            "kind": "box",
            "style": {
                "direction": "column",
                "gap": 12,
                "padding": 24,
                "background": 0xF4F5F7,
            },
        },
        {"kind": "text", "text": "Bun Native React", "style": {"font_size": 28}},
        {"kind": "text", "text": f"Clicks: {clicks}", "style": {}},
        {
            "kind": "button",
            "text": "Increment",
            "disabled": False,
            "style": {"width": 160, "height": 44},
        },
        {"kind": "text", "text": "Native editable input", "style": {}},
        {
            "kind": "input",
            "value": value,
            "placeholder": "Type here…",
            "style": {"width": "fill", "font_size": 24},
        },
        {"kind": "text", "text": f"Input: {value}", "style": {}},
        {"kind": "box", "style": {"direction": "row", "gap": 16}},
        {"kind": "text", "text": "Alpha", "style": {}},
        {"kind": "text", "text": "Beta", "style": {}},
        {"kind": "text", "text": "Gamma", "style": {}},
    ]
    children = {
        1: [2],
        2: [3],
        3: [4, 5, 6, 7, 8, 9, 10],
        10: [13, 11] if clicks else [11, 12, 13],
    }
    result = []
    for identity, element in enumerate(elements, 1):
        if clicks and identity == 12:
            continue
        node = {
            "node_id": identity,
            "element": element,
            "children": children.get(identity, []),
        }
        if identity == 8:
            node["input_revision"] = len(value.replace("{nonce}", "0" * 32))
        result.append(node)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario", choices=["counter-click", "counter-input"], required=True
    )
    parser.add_argument("--mode", choices=["development", "aot"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("supply the application command after --")
    click = args.scenario == "counter-click"
    initial = {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": 1,
        "nodes": nodes(0, ""),
    }
    final = {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "nodes": nodes(1 if click else 0, "" if click else "React {nonce}"),
    }
    if click:
        final["tree_revision"] = 2
    event = (
        {"type": "click", "sequence": 1, "target": "increment"}
        if click
        else {
            "type": "input",
            "sequence": 38,
            "input_revision": 38,
            "value": "React {nonce}",
        }
    )
    event["stage"] = "bun-application"
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
        "Bun Native React",
        "--timeout",
        "30",
        "--expect-software-renderer",
        "--expect-initial-render",
        json.dumps(initial),
        "--expect-render",
        json.dumps(final),
        "--expect-event",
        json.dumps(event),
    ]
    arguments += (
        ["--click", "100", "130"]
        if click
        else ["--key", "ctrl+a", "--text", "React {nonce}"]
    )
    os.execv(sys.executable, [*arguments, "--", *command])


if __name__ == "__main__":
    main()

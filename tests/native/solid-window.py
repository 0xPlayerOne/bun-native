#!/usr/bin/env python3
"""Independent native-tree expectations for the actual Solid fixtures.

Run inside the existing isolated native-linux-session.sh display. This replaces
itself with the tested input driver, preserving that driver's bounded process
ownership, cancellation and cleanup instead of introducing another supervisor.
"""

import argparse
import json
import os
from pathlib import Path
import sys


def counter_nodes(clicks, value):
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
        {"kind": "text", "text": "Bun Native Solid", "style": {"font_size": 28}},
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
    nodes = []
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
        nodes.append(node)
    return nodes


def intent_nodes(applied):
    elements = [
        {"kind": "box", "style": {}},
        {"kind": "box", "style": {}},
        {"kind": "box", "style": {"direction": "column", "gap": 12, "padding": 24}},
        {"kind": "text", "text": "Solid input revision contract", "style": {}},
        {
            "kind": "input",
            "value": "Explicit replacement" if applied else "",
            "placeholder": "",
            "style": {"width": "fill", "font_size": 24},
        },
        {
            "kind": "text",
            "text": "Revision: 38" if applied else "Revision: 0",
            "style": {},
        },
    ]
    nodes = []
    for identity, element in enumerate(elements, 1):
        node = {
            "node_id": identity,
            "element": element,
            "children": {1: [2], 2: [3], 3: [4, 5, 6]}.get(identity, []),
        }
        if identity == 5:
            node["input_revision"] = 39 if applied else 0
        nodes.append(node)
    return nodes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        choices=["counter-click", "counter-input", "input-intent"],
        required=True,
    )
    parser.add_argument("--mode", choices=["development", "aot"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("supply the application command after --")
    is_intent = args.scenario == "input-intent"
    is_click = args.scenario == "counter-click"
    initial = {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "tree_revision": 1,
        "nodes": intent_nodes(False) if is_intent else counter_nodes(0, ""),
    }
    final = {
        "type": "rendered",
        "stage": "native-paint",
        "window_id": 1,
        "nodes": intent_nodes(True)
        if is_intent
        else counter_nodes(1 if is_click else 0, "" if is_click else "Solid {nonce}"),
    }
    if is_click:
        final["tree_revision"] = 2
    event = (
        {"type": "click", "sequence": 1, "target": "increment"}
        if is_click
        else {
            "type": "input",
            "sequence": 38,
            "input_revision": 38,
            "value": "Solid {nonce}",
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
        "Bun Native Solid Input" if is_intent else "Bun Native Solid",
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
        if is_click
        else ["--key", "ctrl+a", "--text", "Solid {nonce}"]
    )
    os.execv(sys.executable, [*arguments, "--", *command])


if __name__ == "__main__":
    main()

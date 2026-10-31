#!/usr/bin/env python3
"""Full-tree expectations for shared renderer keyboard/caret/selection fixtures.

Run inside native-linux-session.sh. This execs the common owned input driver;
it supplies no alternate process supervisor, event dispatch or rendering path.
"""

import argparse
import json
import os
from pathlib import Path
import sys


def nodes(framework, clicks, value):
    elements = [
        {"kind": "box", "style": {}},
        {"kind": "box", "style": {}},
        {"kind": "box", "style": {"direction": "column", "padding": 24, "gap": 12}},
        {
            "kind": "text",
            "text": f"{framework} native event properties",
            "style": {"height": 32, "font_size": 24},
        },
        {"kind": "text", "text": f"Clicks: {clicks}", "style": {"height": 28}},
        {
            "kind": "button",
            "text": "Native action",
            "disabled": False,
            "style": {"width": 200, "height": 44},
        },
        {
            "kind": "input",
            "value": value,
            "placeholder": "",
            "style": {"width": "fill", "height": 40, "font_size": 20},
        },
        {"kind": "text", "text": f"Input: {value}", "style": {"height": 28}},
    ]
    result = []
    for identity, element in enumerate(elements, 1):
        node = {
            "node_id": identity,
            "element": element,
            "children": {1: [2], 2: [3], 3: [4, 5, 6, 7, 8]}.get(identity, []),
        }
        if identity == 7:
            node["input_revision"] = 0 if value == "ABCD" else 1
        result.append(node)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--renderer", choices=["React", "Solid"], required=True)
    parser.add_argument(
        "--scenario", choices=["keyboard", "caret", "selection"], required=True
    )
    parser.add_argument("--mode", choices=["development", "aot"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("supply the application command after --")
    os.environ["BUN_NATIVE_RENDERER_EVENT_SCENARIO"] = args.scenario
    keyboard = args.scenario == "keyboard"
    value = {"keyboard": "ABCD", "caret": "AxBCD", "selection": "AYCD"}[args.scenario]
    expected = {"type": "rendered", "stage": "native-paint", "window_id": 1}
    initial = {**expected, "tree_revision": 1, "nodes": nodes(args.renderer, 0, "ABCD")}
    final = {
        **expected,
        "tree_revision": 3,
        "nodes": nodes(args.renderer, 2 if keyboard else 1, value),
    }
    event = {
        "type": "click" if keyboard else "input",
        "stage": "bun-application",
        "framework": args.renderer,
        "qualified": True,
        "scenario": args.scenario,
        "activations": 2 if keyboard else 1,
        "inputChanges": 0 if keyboard else 1,
        "input": {"value": value, "revision": 0 if keyboard else 1},
    }
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
        f"Bun Native {args.renderer} Events",
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
    if keyboard:
        arguments += ["--key", "Return"]
    else:
        arguments += ["--key", "Tab", "--key", "Home", "--key", "Right"]
        if args.scenario == "selection":
            arguments += ["--key", "shift+Right"]
        arguments += ["--text", "x" if args.scenario == "caret" else "Y"]
    os.execv(sys.executable, [*arguments, "--", *command])


if __name__ == "__main__":
    main()

"""Analyze experimental snapshot roots; no conclusion about earlier collections."""

import argparse
import gzip
import json
from collections import deque
from pathlib import Path


WEAK_SOURCES = {"WeakRef", "JSWeakObjectRef"}


def analyze(snapshot, targets):
    nodes = snapshot["nodes"]
    edges = snapshot["edges"]
    roots = snapshot["conservativeRoots"]
    classes = snapshot["nodeClassNames"]
    if len(nodes) % 7 or len(edges) % 4 or not isinstance(roots, list):
        raise ValueError("Malformed experimental snapshot")
    if len(roots) != len(set(roots)):
        raise ValueError("Duplicate conservative root")
    cells = {}
    addresses = {}
    for offset in range(0, len(nodes), 7):
        node_id, _, class_id, _, _, address, _ = nodes[offset : offset + 7]
        if node_id in cells or not isinstance(address, str):
            raise ValueError("Invalid snapshot node")
        try:
            normalized = hex(int(address, 16))
            class_name = classes[class_id]
        except (ValueError, TypeError, IndexError):
            raise ValueError("Invalid node address or class") from None
        cells[node_id] = (normalized, class_name)
        addresses[normalized] = node_id
    if any(root not in cells for root in roots):
        raise ValueError("Unknown conservative root")
    incoming = {}
    for offset in range(0, len(edges), 4):
        source, target = edges[offset : offset + 2]
        if source in cells and target in cells and cells[source][1] not in WEAK_SOURCES:
            incoming.setdefault(target, []).append(source)
    root_set = set(roots)
    results = []
    for target in targets:
        try:
            address = hex(int(target["address"], 16))
        except (ValueError, KeyError, TypeError):
            results.append({"index": target.get("index"), "present": False})
            continue
        start = addresses.get(address)
        if start is None:
            results.append({"index": target.get("index"), "present": False})
            continue
        queue = deque([start])
        next_node = {start: None}
        root = None
        while queue and len(next_node) <= 500_000:
            node = queue.popleft()
            if node in root_set:
                root = node
                break
            for source in incoming.get(node, []):
                if source not in next_node:
                    next_node[source] = node
                    queue.append(source)
        path = []
        while root is not None:
            path.append(
                {"node": root, "address": cells[root][0], "class": cells[root][1]}
            )
            root = next_node[root]
        results.append(
            {
                "index": target.get("index"),
                "present": True,
                "conservativePath": path,
                "searchTruncated": bool(queue and len(next_node) > 500_000),
            }
        )
    return {"conservativeRootCount": len(roots), "targets": results}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("report", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with gzip.open(args.snapshot, "rt", encoding="utf8") as source:
        snapshot = json.load(source)
    report = json.loads(args.report.read_text(encoding="utf8"))
    result = analyze(snapshot, report["targets"])
    result["scope"] = (
        "Later instrumented snapshot only; omitted edges and other roots remain possible"
    )
    with args.output.open("x", encoding="utf8") as output:
        json.dump(result, output, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()

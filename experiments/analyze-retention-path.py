"""Extract recorded strong ancestor paths without exporting unrelated heap values."""

import argparse
import collections
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
for report_path in args.directory.glob("root-trace-*.json"):
    if report_path.name.endswith(".heap.json"):
        continue
    report = json.loads(report_path.read_text())
    heap_path = report_path.with_suffix(".heap.json")
    raw = heap_path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == report["snapshotSha256"]
    snapshot = json.loads(raw)
    assert snapshot["type"] == "GCDebugging" and snapshot["version"] == 3
    assert (
        len(snapshot["nodes"]) % 7
        == len(snapshot["edges"]) % 4
        == len(snapshot["roots"]) % 3
        == 0
    )
    nodes = {}
    addresses = {}
    incoming = collections.defaultdict(list)
    roots = collections.defaultdict(list)
    for i in range(0, len(snapshot["nodes"]), 7):
        row = snapshot["nodes"][i : i + 7]
        nodes[row[0]] = {
            "id": row[0],
            "class": snapshot["nodeClassNames"][row[2]],
            "label": snapshot["labels"][row[4]][:512],
            "address": row[5],
        }
        if row[0]:
            addresses[row[5]] = row[0]
    for i in range(0, len(snapshot["roots"]), 3):
        identifier, reason, reachability = snapshot["roots"][i : i + 3]
        roots[identifier].append(
            {
                "reason": snapshot["labels"][reason],
                "reachability": snapshot["labels"][reachability],
            }
        )
    for i in range(0, len(snapshot["edges"]), 4):
        source, target, kind, extra = snapshot["edges"][i : i + 4]
        name = snapshot["edgeTypes"][kind]
        incoming[target].append(
            {
                "from": source,
                "to": target,
                "type": name,
                "name": snapshot["edgeNames"][extra][:256]
                if name in ("Property", "Variable")
                else extra
                if name == "Index"
                else None,
            }
        )
    observations = []
    for target in report["targets"]:
        target_id = addresses[target["address"]]
        next_edge = {target_id: None}
        queue = collections.deque([target_id])
        while queue:
            current = queue.popleft()
            for edge in incoming[current]:
                source = edge["from"]
                # The debugging serializer records WeakRef targets as edges too.
                if nodes[source]["class"] == "WeakRef" or source in next_edge:
                    continue
                next_edge[source] = edge
                queue.append(source)
        found = []
        counts = collections.Counter()
        for source in next_edge:
            for root in roots.get(source, []):
                counts[root["reason"]] += 1
                if counts[root["reason"]] > 16:
                    continue
                path = []
                current = source
                while current != target_id:
                    edge = next_edge[current]
                    path.append({"node": nodes[current], "edge": edge})
                    current = edge["to"]
                path.append({"node": nodes[target_id]})
                found.append({"root": root, "path": path})
        observations.append(
            {
                "target": target,
                "recordedAncestors": len(next_edge),
                "rootReasonCounts": dict(counts),
                "paths": found,
                "pathsTruncatedPerReason": any(c > 16 for c in counts.values()),
            }
        )
    output = {
        "receipt": report,
        "graphNodes": len(nodes),
        "graphEdges": len(snapshot["edges"]) // 4,
        "traversal": "All recorded incoming edges excluding edges sourced at WeakRef objects; shortest representative path to each root, at most sixteen per reason. Hidden edges remain unknown.",
        "observations": observations,
    }
    destination = report_path.with_suffix(".paths.json")
    encoded = json.dumps(output, indent=2) + "\n"
    assert len(encoded.encode()) <= 16 * 1024 * 1024
    destination.write_text(encoded)
    print(
        json.dumps(
            {
                "report": str(destination),
                "roots": [o["rootReasonCounts"] for o in observations],
            }
        )
    )

// One-use failure observer, not a collection oracle or production instrumentation.
import * as jsc from "bun:jsc";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const snapshot = Reflect.get(jsc, "generateHeapSnapshotForDebugging");
const describe = Reflect.get(jsc, "jscDescribe");
function address(value) {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  )
    return null;
  const found = /: (0x[0-9a-f]+) /.exec(describe(value));
  if (!found) throw new Error("Cannot identify heap object");
  return found[1];
}
function identities(references, context) {
  return {
    targets: references.flatMap((reference, index) => {
      const value = reference.deref();
      return value === undefined ? [] : [{ index, address: address(value) }];
    }),
    application: address(context.application),
    window: address(context.window),
    transactionTail: address(Reflect.get(context.application, "tail")),
  };
}
function safeName(value) {
  return typeof value === "string" &&
    /^[A-Za-z_$][A-Za-z0-9_.$ :<>()[\]-]{0,100}$/.test(value)
    ? value
    : "[redacted]";
}
export function capture(
  references,
  context,
  output = process.env["BN_FAILURE_GRAPH_OUTPUT"],
) {
  if (!output) throw new Error("Missing exclusive output path");
  if (typeof snapshot !== "function" || typeof describe !== "function")
    throw new Error("Pinned debugging exports unavailable");
  const ids = identities(references, context);
  // This performs an additional collection AFTER the original assertion failed.
  // The original WeakRef predicate and identities() keep targets alive this job.
  const heap = snapshot();
  if (
    heap.type !== "GCDebugging" ||
    heap.version !== 3 ||
    heap.nodes.length % 7 ||
    heap.edges.length % 4 ||
    heap.roots.length % 3
  )
    throw new Error("Unexpected pinned heap schema");
  if (heap.nodes.length > 1750000 || heap.edges.length > 4000000)
    throw new Error("Heap exceeds fixed investigation bounds");
  const nodes = new Map();
  const byAddress = new Map();
  for (let i = 0; i < heap.nodes.length; i += 7) {
    const id = heap.nodes[i];
    const className = heap.nodeClassNames[heap.nodes[i + 2]];
    const node = {
      id,
      className: safeName(className),
      size: heap.nodes[i + 1],
      flags: heap.nodes[i + 3],
      label:
        className === "Function"
          ? safeName(heap.labels[heap.nodes[i + 4]])
          : "",
      address: heap.nodes[i + 5],
      rootReasons: [],
      incomingCount: 0,
    };
    nodes.set(id, node);
    byAddress.set(node.address, id);
  }
  for (let i = 0; i < heap.roots.length; i += 3) {
    const node = nodes.get(heap.roots[i]);
    if (node)
      node.rootReasons.push({
        reason: safeName(heap.labels[heap.roots[i + 1]]),
        reachability: safeName(heap.labels[heap.roots[i + 2]]),
      });
  }
  const incoming = new Map();
  for (let i = 0; i < heap.edges.length; i += 4) {
    const from = heap.edges[i],
      to = heap.edges[i + 1];
    const type = heap.edgeTypes[heap.edges[i + 2]];
    const edge = {
      from,
      to,
      type: safeName(type),
      name:
        type === "Index"
          ? heap.edges[i + 3]
          : type === "Property" || type === "Variable"
            ? safeName(heap.edgeNames[heap.edges[i + 3]])
            : null,
    };
    if (!incoming.has(to)) incoming.set(to, []);
    incoming.get(to).push(edge);
    if (nodes.has(to)) nodes.get(to).incomingCount++;
  }
  const anchors = Object.fromEntries(
    ["application", "window", "transactionTail"].map((name) => [
      name,
      { address: ids[name], id: byAddress.get(ids[name]) ?? null },
    ]),
  );
  const targets = ids.targets.map((target) => {
    const start = byAddress.get(target.address);
    if (start === undefined) return { ...target, absentFromSnapshot: true };
    const seen = new Set([start]),
      pending = [start],
      edges = [];
    let truncated = false;
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i];
      if (id === 0) continue;
      for (const edge of incoming.get(id) ?? []) {
        edges.push(edge);
        if (!seen.has(edge.from)) {
          if (seen.size >= 600) {
            truncated = true;
            continue;
          }
          seen.add(edge.from);
          pending.push(edge.from);
        }
        if (edges.length >= 3000) {
          truncated = true;
          break;
        }
      }
      if (edges.length >= 3000) break;
    }
    return {
      ...target,
      id: start,
      truncated,
      nodes: [...seen].map((id) => nodes.get(id)),
      edges,
      reachableFromAnchors: Object.fromEntries(
        Object.entries(anchors).map(([name, anchor]) => [
          name,
          seen.has(anchor.id),
        ]),
      ),
    };
  });
  const report = {
    schemaVersion: 1,
    scope:
      "Failure-only visible incoming heap graph; not the original marking root or merge qualification",
    limitations: [
      "Original predicate and observer dereferences keep targets alive during this job.",
      "Snapshot performs another collection.",
      "Hidden/conservative edges may be omitted; no incoming edge does not prove no retaining root.",
      "Labels are restricted; bounded traversals explicitly flag truncation.",
    ],
    runtime: {
      revision: Bun.revision,
      platform: process.platform,
      architecture: process.arch,
    },
    heap: {
      nodeCount: nodes.size,
      edgeCount: heap.edges.length / 4,
      sha256: createHash("sha256").update(JSON.stringify(heap)).digest("hex"),
    },
    anchors,
    targets,
  };
  const encoded = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > 750000)
    throw new Error("Reduced graph exceeds fixed output bound");
  writeFileSync(output, encoded, { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      failureGraph: output,
      targets: targets.map((t) => ({
        index: t.index,
        id: t.id,
        truncated: t.truncated,
        reachableFromAnchors: t.reachableFromAnchors,
      })),
    }),
  );
}

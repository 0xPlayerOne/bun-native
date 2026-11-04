// Observer controls; this script never runs inside the full-suite processes.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, normalizePointer } from "./failure-graph.mjs";
const output = process.argv[2];
if (!output) throw new Error("Missing exclusive control output directory");
mkdirSync(output);
for (const value of ["0xabcdef1234", "000000ABCDEF1234", "0XABCDEF1234"])
  assert.equal(normalizePointer(value), "0xabcdef1234");
for (const value of ["", "0x", "0xgg", null, 123, "0x1234 other"])
  assert.throws(() => normalizePointer(value));
const target = { marker: "known diagnostic target" };
const application = { tail: Promise.resolve(), held: target };
const context = { application, window: {} };
const references = [new WeakRef(target)];
const heldPath = join(output, "held.json");
capture(references, context, heldPath);
const held = JSON.parse(readFileSync(heldPath, "utf8"));
assert.equal(held.targets[0].reachableFromAnchors.application, true);
assert.equal(held.targets[0].truncated, false);
assert.ok(
  held.targets[0].edges.some(
    (edge) =>
      edge.name === "held" &&
      edge.from === held.anchors.application.id &&
      edge.to === held.targets[0].id,
  ),
);
delete application.held;
const releasedPath = join(output, "released.json");
capture(references, context, releasedPath);
const released = JSON.parse(readFileSync(releasedPath, "utf8"));
assert.equal(released.targets[0].reachableFromAnchors.application, false);
assert.equal(released.targets[0].truncated, false);
assert.equal(references[0].deref(), target);
const result = {
  pointerFormatsVerified: true,
  invalidPointersRejected: true,
  knownOwnedEdgeFound: true,
  revokedOwnedEdgeAbsent: true,
  targetKeptLive: true,
  platform: process.platform,
  revision: Bun.revision,
};
writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2), {
  flag: "wx",
});
console.log(JSON.stringify(result));

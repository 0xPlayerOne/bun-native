import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import * as jsc from 'bun:jsc'

// This fixture runs only in an isolated diagnostic process. It deliberately
// keeps a target in an ordinary property while the experimental runtime takes
// a later debugging snapshot. It is not a production GC or timing test.
const [snapshotPath, reportPath] = process.argv.slice(2)
assert(snapshotPath && reportPath)
const target = { marker: 'conservative-snapshot-target' }
const holder = { target }
;(
  globalThis as typeof globalThis & { __conservativeSnapshotHolder?: object }
).__conservativeSnapshotHolder = holder
const address = (value: object) => {
  const result = /: (0x[0-9a-f]+)/i.exec(jsc.jscDescribe(value))
  assert(result?.[1])
  return `0x${BigInt(result[1]).toString(16)}`
}
const targetAddress = address(target)
const holderAddress = address(holder)
const generate = Reflect.get(jsc, 'generateHeapSnapshotForDebugging')
assert.equal(typeof generate, 'function')
const snapshot = generate() as {
  nodes: (number | string)[]
  edges: number[]
  roots: number[]
  conservativeRoots?: number[]
}
assert(Array.isArray(snapshot.conservativeRoots), 'Experimental conservative root field is missing')
assert(snapshot.conservativeRoots.length > 0, 'No conservative roots were observed')
const ids = new Map<string, number>()
for (let i = 0; i < snapshot.nodes.length; i += 7) {
  const raw = String(snapshot.nodes[i + 5])
  ids.set(`0x${BigInt(raw).toString(16)}`, snapshot.nodes[i] as number)
}
const targetId = ids.get(targetAddress)
const holderId = ids.get(holderAddress)
assert(targetId !== undefined && holderId !== undefined, 'Pinned fixture cells missing')
let ordinaryEdge = false
for (let i = 0; i < snapshot.edges.length; i += 4) {
  if (snapshot.edges[i] === holderId && snapshot.edges[i + 1] === targetId) ordinaryEdge = true
}
assert(ordinaryEdge, 'Pinned ordinary property edge missing')
const nodes = new Set(ids.values())
assert(
  snapshot.conservativeRoots.every((id) => nodes.has(id)),
  'Unknown conservative root'
)
const gzip = Bun.gzipSync(JSON.stringify(snapshot))
assert(gzip.byteLength <= 48 * 1024 * 1024, 'Control snapshot exceeds bound')
writeFileSync(snapshotPath, gzip, { flag: 'wx' })
writeFileSync(
  reportPath,
  JSON.stringify({
    targets: [{ index: 0, address: targetAddress }],
    holderAddress,
    targetId,
    holderId,
  }) + '\n',
  { flag: 'wx' }
)

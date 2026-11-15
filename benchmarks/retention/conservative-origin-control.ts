import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dlopen, FFIType, JSCallback } from 'bun:ffi'
import * as jsc from 'bun:jsc'
import { conservativeOriginMasks, type DebugSnapshot } from '../solid/retention-evidence.ts'

// Runs only in an isolated diagnostic process. The native function keeps this
// cell address in a volatile stack slot while the callback requests a snapshot.
// The snapshot stays in memory; only node ID, mask and counts are exported.
const [libraryPath, outputPath] = process.argv.slice(2)
assert(libraryPath && outputPath, 'Expected library and output paths')
const target = { marker: 'conservative-origin-stack-control' }
const description = jsc.jscDescribe(target)
const match = /: (0x[0-9a-f]+)/i.exec(description)
assert(match?.[1], 'Target address is unavailable')
const address = BigInt(match[1])
const generate: unknown = Reflect.get(jsc, 'generateHeapSnapshotForDebugging')
assert(typeof generate === 'function', 'Debugging snapshot is unavailable')
let snapshot: DebugSnapshot | undefined
let failure: unknown
const callback = new JSCallback(
  () => {
    try {
      snapshot = generate() as DebugSnapshot
    } catch (error) {
      failure = error
    }
  },
  { args: [], returns: FFIType.void }
)
const library = dlopen(libraryPath, {
  pin_during_callback: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u64 },
})
try {
  assert(callback.ptr, 'Native callback pointer is unavailable')
  const returned = library.symbols.pin_during_callback(address, callback.ptr)
  assert(BigInt(returned) === address, 'Native stack pin changed')
  if (failure) throw failure
  assert(snapshot, 'Snapshot callback failed')
  assert.equal(target.marker, 'conservative-origin-stack-control')
  const masks = conservativeOriginMasks(snapshot)
  let id: number | undefined
  const nodes = new Set<number>()
  for (let i = 0; i < snapshot.nodes.length; i += 7) {
    nodes.add(snapshot.nodes[i] as number)
    if (BigInt(String(snapshot.nodes[i + 5])) === address) id = snapshot.nodes[i] as number
  }
  assert(
    [...masks.keys()].every((key) => nodes.has(key)),
    'Origin metadata names an unknown node'
  )
  assert(id !== undefined, 'Target absent from snapshot')
  const mask = masks.get(id)
  assert(mask !== undefined && (mask & 12) !== 0, 'Target not observed in a native stack range')
  writeFileSync(
    outputPath,
    JSON.stringify({ targetNodeId: id, originMask: mask, roots: masks.size }) + '\n',
    { flag: 'wx' }
  )
} finally {
  library.close()
  callback.close()
}

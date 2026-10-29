/** Explicit profiling review. Never turns a unit test into a busy-machine timing gate. */
import assert from 'node:assert/strict'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  compareTerminalCaptures,
  terminalReviewEnvelope,
} from '../benchmarks/lib/terminal-regression.ts'
const [operation, first, second, output] = process.argv.slice(2)
assert.equal(Bun.version, '1.4.4')
assert.ok(
  operation === 'capture' || operation === 'envelope' || operation === 'compare',
  'Use review-terminal-regression capture REPORT OUTPUT | envelope CAPTURE OUTPUT | compare BASELINE CANDIDATE OUTPUT'
)
assert.equal(process.argv.slice(2).length, operation === 'compare' ? 4 : 3)
const read = async (path: string) => {
  const size = (await stat(path)).size
  assert.ok(size > 0 && size <= 1024 * 1024)
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
let result: unknown, target: string
if (operation === 'capture') {
  assert.ok(first && second && !output)
  ;(
    globalThis as typeof globalThis & { __bunlyTerminalLoadProfile?: unknown }
  ).__bunlyTerminalLoadProfile = 'windowed'
  const { captureTerminalProfile } = await import('../benchmarks/lib/terminal-profile-review.ts')
  result = await captureTerminalProfile(resolve(first))
  target = second
} else if (operation === 'envelope') {
  assert.ok(first && second && !output)
  result = terminalReviewEnvelope(await read(first))
  target = second
} else {
  assert.ok(first && second && output)
  result = compareTerminalCaptures(await read(first), await read(second))
  target = output
}
await writeFile(resolve(target), JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
})
console.log(JSON.stringify({ operation, output: resolve(target), releaseApproved: false }))

if (operation === 'compare' && (result as { reviewRequired: boolean }).reviewRequired)
  process.exitCode = 2

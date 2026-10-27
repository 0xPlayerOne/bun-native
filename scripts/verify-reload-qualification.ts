/** Replay the bounded public matrix and exact historical harness sources, without execution. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { acceptReloadMatrix } from '../benchmarks/reload/acceptance.ts'
const args = process.argv.slice(2)
assert.equal(args.length, 1, 'Use verify-reload-qualification REPORT')
const path = resolve(args[0]!)
const info = await lstat(path)
assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2 * 1024 * 1024)
const bytes = await readFile(path)
assert.equal(bytes.length, info.size)
const report = JSON.parse(bytes.toString()) as Record<string, unknown>
const outcomes = acceptReloadMatrix(report)
const source = report['sourceBefore'] as { commit: string }
for (const { path, sha256 } of report['sourceHashes'] as { path: string; sha256: string }[]) {
  const blob = Bun.spawnSync(['git', 'show', `${source.commit}:${path}`], {
    cwd: resolve(import.meta.dir, '..'),
  })
  assert.equal(
    blob.exitCode,
    0,
    'Historical source missing; no implicit fetch or current-source substitution'
  )
  assert.equal(createHash('sha256').update(blob.stdout).digest('hex'), sha256, path)
}
console.log(
  JSON.stringify({
    profile: 'reload-mechanisms-retained-replay',
    outcomes,
    source: source.commit,
    reportSha256: createHash('sha256').update(bytes).digest('hex'),
    nativeReloadQualified: false,
  })
)

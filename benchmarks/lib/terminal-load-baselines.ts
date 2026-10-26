/** Ask the maintained pinned adapters for this exact scenario; never substitute ANSI-only work. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { electronIdentity, electronScenario } from '../adapters/electron/driver.ts'
import { electrobunIdentity, electrobunScenario } from '../adapters/electrobun/driver.ts'
import { LOAD } from '../../examples/cef-terminal-load/workload.ts'
export async function terminalLoadBaselines() {
  const root = resolve(import.meta.dir, '../..')
  const sources = [
    'benchmarks/references.json',
    'benchmarks/adapters/electron/package.json',
    'benchmarks/adapters/electron/bun.lock',
    'benchmarks/adapters/electron/driver.ts',
    'benchmarks/adapters/electron/main.cjs',
    'benchmarks/adapters/electrobun/package.json',
    'benchmarks/adapters/electrobun/bun.lock',
    'benchmarks/adapters/electrobun/driver.ts',
    'benchmarks/adapters/electrobun/template/main.ts.txt',
  ]
  const hashes = Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(resolve(root, path)))
          .digest('hex'),
      ])
    )
  )
  const variants = []
  for (const [identity, invoke] of [
    [electronIdentity, electronScenario],
    [electrobunIdentity, electrobunScenario],
  ] as const) {
    const manifest = JSON.parse(
      await readFile(resolve(root, `benchmarks/adapters/${identity.id}/package.json`), 'utf8')
    )
    assert.equal(
      manifest.dependencies[identity.id],
      identity.version,
      'Pinned baseline version changed'
    )
    const result = await invoke(LOAD.id)
    // Adding real workload support requires a comparison review, not automatic
    // admission of differently measured or differently secured results.
    assert.equal(
      result.status,
      'unsupported',
      'Baseline capability changed: qualify the complete same-workload profile before admission'
    )
    assert.deepEqual(result.metrics, {})
    variants.push({
      identity,
      request: LOAD.id,
      result,
      execution: 'capability-refused-no-runtime-trial',
      comparison: 'REFUSED',
      reason:
        identity.id === 'electrobun'
          ? 'Existing adapter has no true PTY load; exact Chromium binary and CEF sandbox remain unverified. Packaged Bun is not replaced.'
          : 'Existing adapter has no true PTY load. Its sandboxed synthetic ANSI renderer fixture cannot substitute for this workload.',
    })
  }
  return {
    schema: 1,
    workload: LOAD.id,
    sources: hashes,
    variants,
    ratios: null,
    regressionBudgets: null,
    classification: 'capability-preflight-not-comparative-execution',
  }
}

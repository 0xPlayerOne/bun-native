import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const harness = resolve(import.meta.dir, '../../benchmarks/tooling/controller-solid-stages.ts')

function run(args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env['MIMALLOC_PURGE_DELAY']
  const result = Bun.spawnSync([process.execPath, harness, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

// The harness reads Linux /proc/self/status VmRSS.
describe.if(process.platform === 'linux')('Solid controller stage harness', () => {
  for (const stage of ['full', 'transform', 'bundle']) {
    test(`${stage} worker checks every edit and reports one record`, () => {
      const result = run(['--worker', stage, '--builds', '2'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const record = JSON.parse(result.stdout)
      expect(record).toMatchObject({ stage, policy: 'default', builds: 2 })
      expect(record.finalRssBytes).toBeGreaterThan(0)
      expect(record.heapSizeBytes).toBeGreaterThan(0)
    })
  }

  test('rejects unknown stages', () => {
    const result = run(['--worker', 'babel', '--builds', '1'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--worker must be one of full, transform, bundle')
  })
})

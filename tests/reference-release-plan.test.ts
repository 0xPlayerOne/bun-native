import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareReferenceRelease } from '../benchmarks/adapters/references/release-plan.ts'
import { validateReleasePlan } from '../benchmarks/lib/release-workflow.ts'
for (const name of ['mirin', 'butter'] as const)
  test(`prepare ${name} real CLI stages without installing or inventing a frozen graph`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-reference-plan-'))
    try {
      const lock = join(root, 'frozen.lock'),
        bytes = 'test-only graph; never installed'
      await writeFile(lock, bytes)
      const digest = createHash('sha256').update(bytes).digest('hex'),
        workspace = join(root, 'app')
      const plan = await prepareReferenceRelease(name, workspace, lock, digest)
      expect(plan.tasks['cold-install']?.commands[0]).toContain('--frozen-lockfile')
      expect(plan.tasks['app-assembly']?.dependsOn).toEqual(['cold-install'])
      expect(plan.tasks['installer-compress']?.verify).toContain('verify')
      expect(plan.unsupported['release-sign']).toContain('No independently')
      expect(plan.unsupported['first-run']).toContain('not startup')
      expect(plan.unsupported.update).toContain('not a verified')
      expect(await readFile(join(workspace, 'bun.lock'), 'utf8')).toBe(bytes)
      await expect(prepareReferenceRelease(name, workspace, lock, digest)).rejects.toThrow()
      await expect(
        prepareReferenceRelease(name, join(root, 'wrong'), lock, '0'.repeat(64))
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
test('a caller cannot replace the per-stage verification nonce through environment', () => {
  const value = {
    schema: 1,
    framework: 'fixture',
    version: '1',
    sourceCommit: 'a'.repeat(40),
    tasks: {
      'app-assembly': {
        dependsOn: [],
        commands: [['bun', 'build']],
        verify: ['bun', 'verify'],
        timeoutMs: 500,
        outputs: [],
        environment: { BUNLY_BENCH_NONCE: 'forged' },
      },
    },
    unsupported: {
      'cold-install': 'not tested',
      'warm-dev-launch': 'not tested',
      'frontend-edit': 'not tested',
      'backend-edit': 'not tested',
      'release-sign': 'not tested',
      'installer-compress': 'not tested',
      'first-run': 'not tested',
      update: 'not tested',
    },
  }
  expect(() => validateReleasePlan(value)).toThrow('environment')
})

test('reference profiles select ad-hoc signing explicitly, never an empty certificate name', async () => {
  for (const filename of ['release-plan.ts', 'driver.ts']) {
    const source = await Bun.file(
      new URL('../benchmarks/adapters/references/' + filename, import.meta.url)
    ).text()
    expect(source).toContain("MIRIN_SIGN_IDENTITY: '-'")
    expect(source).not.toContain("MIRIN_SIGN_IDENTITY: ''")
  }
})

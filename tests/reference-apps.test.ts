import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  REFERENCE_PACKAGES,
  referenceInstallation,
} from '../benchmarks/adapters/references/packages.ts'
import { referenceArtifactPath } from '../benchmarks/adapters/references/layout.ts'
import { desktopEditStages } from '../benchmarks/lib/desktop-report.ts'
import type { DesktopEditResult } from '../benchmarks/lib/desktop-edits.ts'
const hash = (x: string) => createHash('sha256').update(x).digest('hex')
test('reference profiles and command names are explicit, not Electron aliases', () => {
  expect(REFERENCE_PACKAGES.mirin.build).toEqual(['build'])
  expect(REFERENCE_PACKAGES.butter.build).toEqual(['compile'])
  expect(referenceArtifactPath('butter', 'win32')).toBe('dist/bunlyreference.exe')
  expect(referenceArtifactPath('mirin', 'linux')).toBe('build/BunlyReference')
  expect(referenceArtifactPath('mirin', 'darwin')).toBe('build/BunlyReference.app')
  expect(() => referenceArtifactPath('mirin', 'android')).toThrow()
})
async function installation(run: (path: string, digest: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'bunly-reference-install-'))
  try {
    await writeFile(join(path, 'bun.lock'), 'test-only-lock')
    const pkg = join(path, 'node_modules/butterframework')
    await mkdir(join(pkg, 'src/cli'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'butterframework', version: '1.6.3' })
    )
    await writeFile(join(pkg, 'src/cli/index.ts'), '// test fixture, never native code')
    await run(path, hash('test-only-lock'))
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}
test('installation records content and lock digests without asserting publisher provenance', async () =>
  installation(async (path, digest) => {
    const value = await referenceInstallation('butter', path, digest)
    expect(value.packages).toHaveLength(1)
    expect(value.sourceVerified).toBe(false)
    expect(value.lockSha256).toBe(digest)
  }))
test('modified lock and wrong runtime version fail before executing code', async () =>
  installation(async (path, digest) => {
    await expect(referenceInstallation('butter', path, 'f'.repeat(64))).rejects.toThrow()
    await writeFile(
      join(path, 'node_modules/butterframework/package.json'),
      JSON.stringify({ name: 'butterframework', version: '1.6.4' })
    )
    await expect(referenceInstallation('butter', path, digest)).rejects.toThrow()
  }))
test('reference entrypoint cannot escape the installed package', async () =>
  installation(async (path, digest) => {
    const entry = join(path, 'node_modules/butterframework/src/cli/index.ts')
    await rm(entry)
    await writeFile(join(path, 'outside.ts'), '// not package content')
    await symlink(join(path, 'outside.ts'), entry)
    await expect(referenceInstallation('butter', path, digest)).rejects.toThrow()
  }))
test('standalone executable assembly is explicit and not a directory substitute', () => {
  const result: DesktopEditResult = {
    passed: true,
    kind: 'desktop',
    artifactKind: 'standalone-executable',
    cleanupFailures: [],
    steps: [
      {
        name: 'initial-build',
        status: 'passed',
        elapsedMs: 2,
        reason: 'fixture',
        observations: [],
        timings: {},
      },
      {
        name: 'backend-edit',
        status: 'passed',
        elapsedMs: 3,
        reason: 'fixture',
        observations: [],
        timings: {},
      },
    ],
  }
  expect(
    desktopEditStages(result, null).find((row) => row.stage === 'app-assembly')?.elapsedMs
  ).toBe(2)
})
test('both authored templates use the common revision fixture and report unverified sandbox', async () => {
  for (const name of ['mirin', 'butter']) {
    const text = await readFile(
      join(import.meta.dir, '../benchmarks/fixtures/desktop-edit/' + name + '.ts.txt'),
      'utf8'
    )
    expect(text).toContain("from './revision.ts'")
    expect(text).toContain("sandbox: 'unverified'")
    expect(text).not.toContain('--no-sandbox')
    const transformed = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(text)
    expect(transformed).toContain('register')
  }
})

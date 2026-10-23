import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
test('Electron benchmark runtime guards and source identities match the exact nested pin', async () => {
  const manifest = JSON.parse(
    await readFile(resolve(root, 'benchmarks/adapters/electron/package.json'), 'utf8')
  ) as { dependencies: { electron: string } }
  const version = manifest.dependencies.electron
  assert.match(version, /^44\.\d+\.\d+$/)
  // The reviewed advisory fixes the 44.x line at 44.9.1; no vulnerable fallback.
  const [, minor, patch] = version.split('.').map(Number)
  assert.ok(minor! > 9 || (minor === 9 && patch! >= 1))
  const references = JSON.parse(
    await readFile(resolve(root, 'benchmarks/references.json'), 'utf8')
  ) as { references: { id: string; version: string; commit: string }[] }
  const reference = references.references.find((row) => row.id === 'electron')!
  assert.equal(reference.version, version)
  assert.match(reference.commit, /^[a-f0-9]{40}$/)
  for (const file of [
    'benchmarks/adapters/electron/main.cjs',
    'benchmarks/adapters/electron/driver.ts',
    'benchmarks/adapters/desktop-edit/driver.ts',
    'benchmarks/fixtures/desktop-edit/electron.ts.txt',
  ]) {
    const text = await readFile(resolve(root, file), 'utf8')
    assert.ok(text.includes(`'${version}'`), file)
    assert.ok(!text.includes('44.8.0'), file)
    if (file.endsWith('/driver.ts')) assert.ok(text.includes(reference.commit), file)
  }
  const lock = await readFile(resolve(root, 'benchmarks/adapters/electron/bun.lock'), 'utf8')
  assert.ok(lock.includes(`"electron@${version}"`))
  assert.ok(lock.includes(`"electron": "${version}"`))
})

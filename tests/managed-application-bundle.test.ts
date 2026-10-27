import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManagedApplication } from '../scripts/qualify-managed-development.ts'

test('managed native fixture publishes verified renderer assets while keeping service source maps private', async () => {
  const resources = await mkdtemp(join(tmpdir(), 'bunly-managed-bundle-'))
  try {
    const built = await buildManagedApplication(resources)
    const publicRoot = join(resources, 'public')
    const files = await readdir(publicRoot)
    expect(files).toContain('client.js')
    expect(files).toContain('index.html')
    expect(files).toContain('restart-client.js')
    expect(files).toContain('restart.html')
    expect(files).toContain('xterm-LICENSE.txt')
    // These are rejected by the real native public_name policy. A .map in the
    // inventory previously caused exit78 before the desktop could launch.
    expect(files.some((file) => /\.(?:ts|tsx|jsx|map|rs|py|pyc|pem|key)$/i.test(file))).toBe(false)
    const inventory = JSON.parse(await readFile(join(publicRoot, 'assets.json'), 'utf8'))
    expect(inventory).toEqual(built.assets)
    expect(Object.keys(inventory).sort()).toEqual(
      files.filter((name) => name !== 'assets.json').sort()
    )
    for (const [name, entry] of Object.entries(built.assets)) {
      const bytes = await readFile(join(publicRoot, name))
      expect(entry.bytes).toBe(bytes.length)
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
    expect(await Bun.file(join(resources, 'backend/application.js.map')).exists()).toBe(true)
    expect(await Bun.file(join(resources, 'backend/service-reload-runner.js.map')).exists()).toBe(
      true
    )
    expect(await readFile(join(resources, 'backend/application.js'), 'utf8')).toContain(
      'sourceMappingURL=application.js.map'
    )
    expect(await readFile(join(publicRoot, 'client.js'), 'utf8')).not.toContain(
      'sourceMappingURL=client.js.map'
    )
  } finally {
    await rm(resources, { recursive: true, force: true })
  }
}, 15_000)

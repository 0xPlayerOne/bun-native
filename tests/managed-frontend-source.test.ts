import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManagedFrontendSource } from '../examples/managed-desktop/frontend-source.ts'

test('the maintained frontend adapter delivers actual edited stylesheet and shared-source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-managed-frontend-'))
  try {
    await mkdir(join(root, 'frontend'))
    await mkdir(join(root, 'shared'))
    const style = join(root, 'frontend/style.css')
    const shared = join(root, 'shared/value.ts')
    await writeFile(style, ':root { --fixture-revision: 0; }\n')
    await writeFile(shared, 'export const shared = 0\n')
    const initial = await readManagedFrontendSource(root)
    expect(initial).toMatchObject({ version: 0, frontend: 0, shared: 0 })
    await writeFile(style, ':root { --fixture-revision: 1; }\n')
    const frontend = await readManagedFrontendSource(root)
    expect(frontend).toMatchObject({ version: 1, frontend: 1, shared: 0 })
    expect(frontend.css).toContain('--fixture-revision: 1;')
    expect(frontend.sha256).not.toBe(initial.sha256)
    await writeFile(shared, 'export const shared = 1\n')
    const combined = await readManagedFrontendSource(root)
    expect(combined).toMatchObject({ version: 2, frontend: 1, shared: 1 })
    expect(combined.css).toContain('--managed-shared: 1;')
    expect(combined.sha256).not.toBe(frontend.sha256)
    expect(combined.sha256).toBe(new Bun.CryptoHasher('sha256').update(combined.css).digest('hex'))
    expect(await readManagedFrontendSource(root)).toEqual(combined)
    await writeFile(shared, 'throw new Error("must not evaluate source"); export const shared = 1')
    await expect(readManagedFrontendSource(root)).rejects.toThrow('HMR_SOURCE_INVALID')
    await writeFile(shared, 'export const shared = 1\n')
    await writeFile(style, 'x'.repeat(4097))
    await expect(readManagedFrontendSource(root)).rejects.toThrow('HMR_SOURCE_INVALID')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

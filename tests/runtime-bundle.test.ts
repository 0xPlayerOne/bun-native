import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('bundled runtime loads its separately built generation runner without source files', async () => {
  const output = await mkdtemp(join(tmpdir(), 'bunly-runtime-bundle-'))
  const root = resolve(import.meta.dir, '..')
  try {
    const build = await Bun.build({
      entrypoints: [
        join(root, 'packages/runtime/src/index.ts'),
        join(root, 'packages/runtime/src/service-reload-runner.ts'),
      ],
      outdir: output,
      target: 'bun',
      format: 'esm',
      sourcemap: 'external',
    })
    expect(build.success).toBe(true)
    expect(await Bun.file(join(output, 'service-reload-runner.js')).exists()).toBe(true)
    expect(await Bun.file(join(output, 'service-reload-runner.ts')).exists()).toBe(false)
    const runtime = (await import(
      pathToFileURL(join(output, 'index.js')).href
    )) as typeof import('../packages/runtime/src/index.ts')
    const owner = new runtime.ManagedGenerationOwner()
    const host = new runtime.ServiceReloadHost({ owner, stateSchema: 'bundle:1', permissions: [] })
    try {
      const entry = join(output, 'application.js')
      await writeFile(
        entry,
        "export default () => ({schema:'bundle:1',handlers:{read:()=>JSON.stringify('bundled')}})"
      )
      await host.reload({ entry })
      expect(await host.request('read', 'null')).toBe('"bundled"')
    } finally {
      await host.close()
      owner.dispose()
    }
    expect(host.diagnostics().generations).toBe(0)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 15000)

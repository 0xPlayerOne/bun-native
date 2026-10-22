/** Independent Bun builds overlap; tests and measured workloads remain sequential. */
import { mkdir, copyFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export async function buildWorkspace(root: string): Promise<void> {
  const packages = ['contracts', 'client', 'runtime', 'artifacts', 'cli'] as const
  const tasks = packages.map(async (name) => {
    const outdir = join(root, `packages/${name}/dist`)
    await rm(outdir, { recursive: true, force: true })
    const result = await Bun.build({
      entrypoints: [join(root, `packages/${name}/src/${name === 'cli' ? 'main' : 'index'}.ts`)],
      outdir,
      target: name === 'client' || name === 'contracts' ? 'browser' : 'bun',
      sourcemap: 'external',
    })
    if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${name}`)
  })
  tasks.push(
    (async () => {
      const outdir = join(root, 'examples/workbench/dist')
      // A deleted example asset must not survive a rebuild either.
      await rm(outdir, { recursive: true, force: true })
      await mkdir(outdir, { recursive: true })
      const results = await Promise.allSettled([
        ...(['main', 'browser'] as const).map(async (entry) => {
          const result = await Bun.build({
            entrypoints: [join(root, `examples/workbench/${entry}.ts`)],
            outdir,
            target: entry === 'main' ? 'bun' : 'browser',
            sourcemap: 'external',
          })
          if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${entry}`)
        }),
        copyFile(join(root, 'examples/workbench/index.html'), join(outdir, 'index.html')),
      ])
      const failures = results.filter((r) => r.status === 'rejected')
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          'Workbench build failed'
        )
    })()
  )
  // Wait for every owned writer even on failure; never return while siblings still mutate output.
  const results = await Promise.allSettled(tasks)
  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      'Workspace build failed'
    )
}

if (import.meta.main) {
  await buildWorkspace(resolve(import.meta.dir, '..'))
  console.log('Built SDK, CLI, and contract workbench. No native toolchain invoked.')
}

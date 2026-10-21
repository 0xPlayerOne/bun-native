import { readFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createFixtureServer, type FixtureAssets } from '../benchmarks/fixtures/server.ts'
const root = resolve(import.meta.dir, '..')
export async function loadWorkbenchAssets(): Promise<FixtureAssets> {
  const vendor = join(root, 'benchmarks/fixtures/node_modules/@xterm/xterm')
  const build = await Bun.build({
    entrypoints: [join(root, 'examples/workbench/ui.ts')],
    target: 'browser',
    format: 'iife',
    minify: false,
  })
  if (!build.success || !build.outputs[0])
    throw new Error(`Workbench build failed: ${build.logs.join('\n')}`)
  try {
    const [html, terminalJs, terminalCss] = await Promise.all([
      readFile(join(root, 'examples/workbench/workbench.html'), 'utf8'),
      readFile(join(vendor, 'lib/xterm.js'), 'utf8'),
      readFile(join(vendor, 'css/xterm.css'), 'utf8'),
    ])
    return { html, script: await build.outputs[0].text(), terminalJs, terminalCss }
  } catch (error) {
    throw new Error(
      'Install the pinned fixture dependencies first: bun install --cwd benchmarks/fixtures',
      { cause: error }
    )
  }
}
if (import.meta.main) {
  const assets = await loadWorkbenchAssets()
  await mkdir(join(root, '.bunly/workbench'), { recursive: true })
  const server = await createFixtureServer(assets)
  console.log(
    `Workbench: ${server.origin}\nLocal synthetic data only. Browser preview, not a Bunly native runtime.`
  )
  let closing = false
  const close = () => {
    if (!closing) {
      closing = true
      void server.close()
    }
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

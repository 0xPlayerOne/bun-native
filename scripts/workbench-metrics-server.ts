/** Local shared-workbench entry for the optional browser measurement contributor. */
import { createFixtureServer } from '../benchmarks/fixtures/server.ts'
import { loadWorkbenchAssets } from './workbench.ts'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const assets = await loadWorkbenchAssets()
const instrumentation = await readFile(
  resolve(import.meta.dir, '../benchmarks/fixtures/browser-metrics.js'),
  'utf8'
)
const server = await createFixtureServer({
  ...assets,
  script: assets.script + '\n;' + instrumentation,
})
console.log(JSON.stringify({ event: 'ready', origin: server.origin, bun: Bun.version }))
let closing = false
const close = () => {
  if (!closing) {
    closing = true
    void server.close()
  }
}
process.once('SIGTERM', close)
process.once('SIGINT', close)

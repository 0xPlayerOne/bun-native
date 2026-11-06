import { BrowserWindow, Utils } from 'electrobun/main'
import { writeFileSync } from 'node:fs'

const output = process.env['EB_OUTPUT']
if (!output) throw new Error('EB_OUTPUT is required')
const milestones = {
  mainProcessStartEpochMs: performance.timeOrigin,
  mainEntryMs: performance.now(),
}
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    if (request.method === 'OPTIONS') return new Response(null, { headers })
    if (new URL(request.url).pathname === '/report') {
      const view = JSON.parse(await request.text())
      writeFileSync(
        output,
        JSON.stringify(
          {
            ...milestones,
            windowCreatedMs: windowCreatedMs,
            bunVersion: Bun.version,
            bunRevision: Bun.revision,
            ...view,
          },
          null,
          2
        ) + '\n'
      )
      setTimeout(() => Utils.quit(), 50)
      return new Response('ok', { headers })
    }
    return new Response('not found', { status: 404, headers })
  },
})
const query = new URLSearchParams({ port: String(server.port) })
for (const key of ['iterations', 'rotations', 'mounts', 'rows'])
  if (process.env[`EB_${key.toUpperCase()}`])
    query.set(key, process.env[`EB_${key.toUpperCase()}`]!)
const window = new BrowserWindow({
  title: 'Bun Native matched renderer workload',
  url: `views://mainview/index.html?${query}`,
  frame: { width: 640, height: 720, x: 200, y: 100 },
})
const windowCreatedMs = performance.now()
void window

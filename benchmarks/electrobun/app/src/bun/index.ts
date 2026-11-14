import { BrowserWindow, Utils } from 'electrobun/main'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { handleInputRequest, InputSession } from './input-session'

const output = process.env['EB_OUTPUT']
if (!output) throw new Error('EB_OUTPUT is required')
const control = process.env['EB_INPUT_CONTROL']
const inputNonce = process.env['EB_INPUT_NONCE']
if (Boolean(control) !== Boolean(inputNonce) || (control && !isAbsolute(control)))
  throw new Error('Input comparison requires an absolute control path and nonce')
const input = inputNonce ? new InputSession(inputNonce) : undefined
let notifyClicked: (() => void) | undefined
const clicked = input
  ? new Promise<void>((resolve) => {
      notifyClicked = resolve
    })
  : undefined
const milestones = {
  mainProcessStartEpochMs: performance.timeOrigin,
  mainEntryMs: performance.now(),
}
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  ...(input ? { maxRequestBodySize: 16_384 } : {}),
  async fetch(request) {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    if (request.method === 'OPTIONS') return new Response(null, { headers })
    const path = new URL(request.url).pathname
    const save = (view: unknown) => {
      writeFileSync(
        output,
        JSON.stringify(
          {
            ...milestones,
            windowCreatedMs: windowCreatedMs,
            bunVersion: Bun.version,
            bunRevision: Bun.revision,
            ...(view as Record<string, unknown>),
          },
          null,
          2
        ) + '\n'
      )
      setTimeout(() => Utils.quit(), 50)
    }
    if (input && request.method === 'POST' && path.startsWith('/input/')) {
      if (path === '/input/finish') {
        if (request.headers.get('x-benchmark-nonce') !== inputNonce)
          return new Response('unauthorized', { status: 403, headers })
        window.webview.executeJavascript(
          "window.dispatchEvent(new Event('bun-native-benchmark-finish'))"
        )
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          if (!clicked) throw new Error('Input session is unavailable')
          await Promise.race([
            clicked,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Input click report timed out')), 5_000)
            }),
          ])
        } catch (error) {
          return new Response(String(error), { status: 409, headers })
        } finally {
          if (timeout) clearTimeout(timeout)
        }
      }
      const response = await handleInputRequest(input, request, {
        ready(viewport) {
          writeFileSync(
            control!,
            JSON.stringify({ port: server.port, nonce: inputNonce, viewport }) + '\n',
            { flag: 'wx', mode: 0o600 }
          )
        },
        finish: save,
      })
      if (path === '/input/clicked' && response.ok) notifyClicked?.()
      return response
    }
    if (request.method === 'POST' && path === '/report') {
      if (input && request.headers.get('x-benchmark-nonce') !== inputNonce)
        return new Response('unauthorized', { status: 403, headers })
      const view = JSON.parse(await request.text())
      save(view)
      return new Response('ok', { headers })
    }
    return new Response('not found', { status: 404, headers })
  },
})
const query = new URLSearchParams({ port: String(server.port) })
if (inputNonce) {
  query.set('input', '1')
  query.set('nonce', inputNonce)
}
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

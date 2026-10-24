import assert from 'node:assert/strict'
import { pageTimeout } from './page-readiness.ts'
import { waitForGpuInjection } from './fault-ack.ts'
import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { serveRpcFixture } from './rpc-fixture-service.ts'
export default async function fault(backend: CefBackend): Promise<void> {
  const mode = process.env['BUNLY_CEF_FAULT']
  const faultDeadlineMs = pageTimeout(process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'])
  if (!['backend-exit', 'backend-tree-exit', 'renderer-exit', 'gpu-exit'].includes(mode ?? ''))
    throw new Error('Explicit native qualification fault required')
  // main.js imports rpc-client.js with top-level await. Fault readiness must
  // provision that actual service, not bypass the unchanged asset/RPC checks.
  const { stopRpc } = serveRpcFixture(backend)
  try {
    await runFault(backend, mode!, faultDeadlineMs)
  } finally {
    stopRpc()
  }
}
async function runFault(backend: CefBackend, mode: string, faultDeadlineMs: number): Promise<void> {
  const session = await backend.createSession({
    partition: 'private-fault',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'Bunly private fault test',
    bounds: { x: 10, y: 10, width: 800, height: 600 },
  })
  let finish!: () => void, reject!: (error: Error) => void
  const page = new Promise<void>((ok, bad) => {
    finish = ok
    reject = bad
  })
  void page.catch(() => {})
  let rendererExitSeen = false
  const off = backend.observe((event) => {
    if (event.event === 'view.renderer-exit') rendererExitSeen = true
    const text = String(event.data?.['message'] ?? '')
    if (event.event === 'view.console' && text === 'BUNLY_ASSET_TEST_OK') finish()
    if (text.startsWith('BUNLY_ASSET_TEST_FAILED')) reject(new Error(text))
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    timer = setTimeout(() => reject(new Error('Fault fixture page deadline')), faultDeadlineMs)
    await page
    console.error(JSON.stringify({ event: 'bunly.fault.ready', mode, pid: process.pid }))
    const ready = process.env['BUNLY_CEF_FAULT_READY']
    if (ready !== undefined) {
      const nonce = process.env['BUNLY_CEF_FAULT_NONCE'] ?? ''
      assert.ok(
        isAbsolute(ready) && /^[a-f0-9]{48}$/.test(nonce),
        'Invalid private fault readiness configuration'
      )
      await writeFile(ready, JSON.stringify({ mode, nonce, pid: process.pid }), {
        flag: 'wx',
        mode: 0o600,
      })
    }
    if (mode === 'backend-tree-exit') {
      const descendant = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      console.error(JSON.stringify({ event: 'bunly.fault.descendant', pid: descendant.pid }))
      await Bun.sleep(150)
      process.exit(23)
    }
    if (mode === 'backend-exit') process.exit(23)
    if (mode === 'renderer-exit') {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          backend.closed,
          new Promise<never>((_, bad) => {
            deadline = setTimeout(
              () => bad(new Error('Native renderer failure did not close the host')),
              faultDeadlineMs
            )
          }),
        ])
        assert.ok(rendererExitSeen, 'Missing native renderer exit event')
        console.error(
          JSON.stringify({ event: 'bunly.native.renderer-failure-observed', passed: true })
        )
        return
      } finally {
        if (deadline) clearTimeout(deadline)
      }
    }
    const injected = process.env['BUNLY_CEF_FAULT_INJECTED']
    assert.ok(injected, 'Private GPU fault injection receipt path required')
    await waitForGpuInjection(injected, process.env['BUNLY_CEF_FAULT_NONCE'] ?? '', faultDeadlineMs)
    console.error(
      JSON.stringify({ event: 'bunly.native.gpu-injection-acknowledged', passed: true })
    )
    const extra = await backend.createView({
      window,
      session,
      url: 'app://ui/next.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const loaded = await backend.navigate(extra, 'app://ui/index.html')
    assert.equal(loaded.url, 'app://ui/index.html')
    console.error(JSON.stringify({ event: 'bunly.native.gpu-recovered', passed: true }))
  } finally {
    if (timer) clearTimeout(timer)
    off()
    await backend.dispose()
  }
}

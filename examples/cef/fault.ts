import assert from 'node:assert/strict'
import { rendererFaultExit, rendererFaultShutdown } from './fault-exit.ts'
import { pageTimeout } from './page-readiness.ts'
import { waitForGpuInjection } from './fault-ack.ts'
import { startObservedDirectChild, startObservedShellTree } from './fault-supervision.ts'
import { writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { serveRpcFixture } from './rpc-fixture-service.ts'
export default async function fault(backend: CefBackend): Promise<void> {
  const mode = process.env['BUNLY_CEF_FAULT']
  const faultDeadlineMs = pageTimeout(process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'])
  if (
    ![
      'backend-exit',
      'backend-tree-exit',
      'backend-shell-tree-exit',
      'backend-hang',
      'renderer-exit',
      'gpu-exit',
    ].includes(mode ?? '')
  )
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
  let rendererExitCode: unknown
  let pageReady = false
  let documentReady = false
  const off = backend.observe((event) => {
    if (event.event === 'view.renderer-exit') {
      rendererExitSeen = true
      rendererExitCode = event.data?.['code']
    }
    const text = String(event.data?.['message'] ?? '')
    if (event.event === 'view.console' && text === 'BUNLY_ASSET_TEST_OK') pageReady = true
    if (event.event === 'view.loaded' && event.data?.['url'] === 'app://ui/index.html')
      documentReady = true
    if (pageReady && (mode !== 'renderer-exit' || documentReady)) finish()
    if (text.startsWith('BUNLY_ASSET_TEST_FAILED')) reject(new Error(text))
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    timer = setTimeout(() => reject(new Error('Fault fixture page deadline')), faultDeadlineMs)
    await page
    const rendererScope =
      mode === 'renderer-exit' ? await backend.capturePolicyScope(view) : undefined
    const readiness = { mode, pid: process.pid }
    console.error(JSON.stringify({ event: 'bunly.fault.ready', ...readiness }))
    const ready = process.env['BUNLY_CEF_FAULT_READY']
    if (ready !== undefined) {
      const nonce = process.env['BUNLY_CEF_FAULT_NONCE'] ?? ''
      assert.ok(
        isAbsolute(ready) && /^[a-f0-9]{48}$/.test(nonce),
        'Invalid private fault readiness configuration'
      )
      await writeFile(ready, JSON.stringify({ ...readiness, nonce }), {
        flag: 'wx',
        mode: 0o600,
      })
    }
    if (mode === 'backend-shell-tree-exit') await startObservedShellTree(faultDeadlineMs)
    if (mode === 'backend-hang') {
      // The native quit command is queued before the trusted backend blocks.
      // No JS shutdown handler or timer can run until native escalation kills it.
      void backend.dispose().catch(() => {})
      console.error(
        JSON.stringify({
          event: 'bunly.fault.blocked',
          mode,
          pid: process.pid,
          quitRequested: true,
        })
      )
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      throw new Error('Deliberately blocked backend unexpectedly resumed')
    }
    if (mode === 'backend-tree-exit') await startObservedDirectChild(faultDeadlineMs)
    if (mode === 'backend-exit') process.exit(23)
    if (mode === 'renderer-exit') {
      assert.ok(rendererScope)
      await backend.qualifyRendererCrash(rendererScope)
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        const shutdownRejected = await rendererFaultShutdown(
          Promise.race([
            backend.closed,
            new Promise<never>((_, bad) => {
              deadline = setTimeout(
                () => bad(new Error('Native renderer failure did not close the host')),
                faultDeadlineMs
              )
            }),
          ])
        )
        assert.ok(rendererExitSeen, 'Missing native renderer exit event')

        console.error(
          JSON.stringify({
            ...rendererFaultExit(rendererExitCode, process.platform),
            shutdownRejected,
          })
        )
        // Disposal/bootstrap still observe the same failed close and exit 1.
        // This receipt acknowledges the injected fault; it never makes it clean.
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

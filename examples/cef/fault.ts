import assert from 'node:assert/strict'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
export default async function fault(backend: CefBackend): Promise<void> {
  const mode = process.env['BUNLY_CEF_FAULT']
  if (!['backend-exit', 'backend-tree-exit', 'renderer-exit', 'gpu-exit'].includes(mode ?? ''))
    throw new Error('Explicit native qualification fault required')
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
  const timer = setTimeout(() => reject(new Error('Fault fixture page deadline')), 10000)
  try {
    await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await page
    console.error(JSON.stringify({ event: 'bunly.fault.ready', mode, pid: process.pid }))
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
              10000
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
    await Bun.sleep(3000)
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
    clearTimeout(timer)
    off()
    await backend.dispose()
  }
}

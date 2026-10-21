import assert from 'node:assert/strict'
import { packagedPageReadiness, pageTimeout } from './page-readiness.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
export default async function main(backend: CefBackend): Promise<void> {
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 5)
  const pageDeadlineMs = pageTimeout(process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'])
  const page = packagedPageReadiness((listener) => backend.observe(listener), pageDeadlineMs)
  try {
    const session = await backend.createSession({ partition: 'smoke', persistence: 'ephemeral' })
    const window = await backend.createWindow({
      title: 'Bunly CEF',
      bounds: { x: 0, y: 0, width: 960, height: 640 },
    })
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    await page.wait()
    assert.ok(ticks > 0, 'Bun timers must progress while CEF runs')
    await backend.resizeWindow(window, 1000, 700)
    await backend.showWindow(window, false)
    await backend.showWindow(window, true)
    await backend.focusView(view)
    let detachedEvents = 0
    const detach = backend.observe(() => {
      detachedEvents++
    })
    detach()
    for (let cycle = 0; cycle < 20; cycle++) {
      console.error(JSON.stringify({ event: 'bunly.native.cycle', cycle }))
      const w = await backend.createWindow({
        title: 'Lifecycle ' + cycle,
        bounds: { x: -10, y: 20, width: 400, height: 300 },
      })
      const children = await Promise.all(
        Array.from({ length: 2 }, () =>
          backend.createView({
            window: w,
            session,
            url: 'app://ui/next.html',
            trust: { kind: 'application', origin: 'app://ui' },
          })
        )
      )
      await backend.focusView(children[0]!)
      const pending = backend.navigate(children[1]!, 'app://ui/index.html')
      void pending.catch(() => {})
      await Promise.all([
        backend.closeWindow(w),
        backend.closeWindow(w),
        backend.disposeView(children[0]!),
      ])
      await pending.catch(() => {})
      await backend.closeWindow(w)
      await assert.rejects(backend.navigate(children[1]!, 'app://ui/next.html'))
      assert.equal(backend.diagnostics().windows, 1)
      assert.equal(backend.diagnostics().views, 1)
    }
    assert.equal(detachedEvents, 0)
    await assert.rejects(backend.navigate(view, 'https://blocked.invalid/'))
    await assert.rejects(
      backend.createWindow({ title: 'bad', bounds: { x: 0, y: 0, width: 0, height: 1 } })
    )
    await assert.rejects(
      backend.createView({ window, session, url: 'file:///tmp/secret', trust: { kind: 'remote' } })
    )
    const second = await backend.createWindow({
      title: 'Bunly second window',
      bounds: { x: 30, y: 30, width: 600, height: 400 },
    })
    const other = await backend.createView({
      window: second,
      session,
      url: 'app://ui/next.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    // Do not wait for the initial next.html load: this reproduces the callback
    // race that previously attributed its ERR_ABORTED to the new navigation.
    const navigated = await backend.navigate(other, 'app://ui/index.html')
    assert.equal(navigated.url, 'app://ui/index.html')
    const firstDocument = navigated.documentId
    const reloaded = await backend.navigate(other, 'app://ui/index.html')
    assert.equal(reloaded.url, 'app://ui/index.html')
    assert.notEqual(reloaded.documentId, firstDocument)
    await assert.rejects(
      backend.navigate(other, 'app://ui/index.html#fragment'),
      /same-document navigation/
    )
    assert.equal((await backend.navigate(other, 'app://ui/next.html')).url, 'app://ui/next.html')
    await backend.closeWindow(second)
    await assert.rejects(backend.navigate(other, 'app://ui/next.html'))
    await backend.navigate(view, 'app://ui/next.html')
    await assert.rejects(backend.disposeSession(session))
    console.log(
      JSON.stringify({
        event: 'bunly.native.smoke',
        pageDeadlineMs,
        passed: true,
        cycles: 20,
        timers: ticks,
        diagnostics: await backend.nativeDiagnostics(),
      })
    )
    if (process.env['BUNLY_TEST_LAST_WINDOW'] === '1') {
      await backend.closeWindow(window)
      await backend.closed
      assert.equal(backend.diagnostics().windows, 0)
      assert.equal(backend.diagnostics().views, 0)
      console.error(JSON.stringify({ event: 'bunly.native.last-window', passed: true }))
    } else await backend.dispose()
  } finally {
    clearInterval(timer)
    page.close()
  }
}

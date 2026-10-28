import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ViewHandle } from '../../packages/contracts/src/index.ts'
import type { CefBackend, NativeCapabilityGrant } from '../../packages/runtime/src/cef.ts'
import { remoteDocumentReadiness } from '../file-downloads/readiness.ts'

/** Actual CEF behavior. This fixture never consumes raw CDP or renderer-native RPC. */
export default async function browserActions(backend: CefBackend): Promise<void> {
  const started = performance.now()
  const checks: Record<string, boolean> = {}
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new Error('Browser fixture deadline')), 45_000)
  let phase = 'setup',
    failure: string | null = null
  let screenshot: { bytes: number; width: number; height: number; sha256: string } | null = null
  let accessibility: 'supported' | 'unsupported' | null = null
  let nativeSettled: Record<string, unknown> | null = null
  const childLoaded = Promise.withResolvers<void>()
  const painted = Promise.withResolvers<void>()
  const child = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/loaded') {
        childLoaded.resolve()
        return new Response('ok')
      }
      return new Response(
        '<!doctype html><title>Foreign frame</title><p>FOREIGN_FRAME_SENTINEL</p><script>fetch("/loaded")</script>',
        { headers: { 'content-type': 'text/html' } }
      )
    },
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/painted') {
        painted.resolve()
        return new Response('ok')
      }
      return new Response(
        `<!doctype html><title>Browser action fixture</title><style>body{margin:0}#text{position:fixed;left:16px;top:12px;width:220px;height:24px}#button{position:fixed;left:16px;top:50px;width:100px;height:30px}iframe{position:fixed;left:300px;top:100px;width:200px;height:100px}</style><input id="text"><button id="button">Act</button><main aria-label="${'x'.repeat(900)}"><section><div><span><strong><b>depth-bound</b></strong></span></div></section></main><script>
      const input=document.getElementById('text'), button=document.getElementById('button');
      button.addEventListener('click',event=>{document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);document.body.dataset.trusted=String(event.isTrusted)});
      input.addEventListener('beforeinput',()=>{switch(document.body.dataset.mutation){case 'password':input.type='password';break;case 'disabled':input.disabled=true;break;case 'readonly':input.readOnly=true;break;case 'button':input.type='button';break}});
      </script>`,
        { headers: { 'content-type': 'text/html' } }
      )
    },
  })
  const origin = server.url.origin
  const waitFor = async <T>(promise: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw controller.signal.reason
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const abort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abort, { once: true })
        void promise
          .finally(() => controller.signal.removeEventListener('abort', abort))
          .catch(() => {})
      }),
    ])
  }
  const ready = async (view: ViewHandle, url: string, previous?: string) => {
    const receipt = remoteDocumentReadiness(backend, url, previous)
    try {
      await backend.navigate(view, url)
      await waitFor(receipt.wait(view))
    } finally {
      receipt.close()
    }
  }
  const grant = async (view: ViewHandle, capability: NativeCapabilityGrant) => {
    const scope = await backend.capturePolicyScope(view)
    await backend.grantNativeCapability(scope, capability)
    return scope
  }
  const evaluate = async (view: ViewHandle, expression: string) => {
    await grant(view, { name: 'browser-evaluate', expression })
    return waitFor(backend.evaluate(view, expression, { signal: controller.signal }))
  }
  const owned = async () => {
    const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
    return native['browserActions'] as Record<string, unknown>
  }
  const settled = async () => {
    const value = await owned()
    for (const key of [
      'operations',
      'registrations',
      'callbacks',
      'byteLeases',
      'ownedBytes',
      'reservedBytes',
      'deadlineWorkers',
    ])
      assert.equal(value[key], 0, key)
    return value
  }
  const admitted = async () => {
    const end = performance.now() + 1500
    while (performance.now() < end) {
      if ((await owned())['operations'] === 1) return
      await Bun.sleep(5)
    }
    throw new Error('Native admission not observed')
  }
  try {
    for (const capability of [
      'view.snapshot',
      'view.evaluate',
      'view.input.synthetic',
      'view.observe-dom',
      'view.observe-accessibility',
    ] as const)
      assert.ok(backend.descriptor.capabilities.includes(capability))
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'browser-actions',
      network: { allowedOrigins: [origin, child.url.origin] },
    })
    const window = await backend.createWindow({
      title: 'Browser Actions',
      bounds: { x: 30, y: 30, width: 1200, height: 900 },
    })
    let url = origin + '/document?initial'
    const first = remoteDocumentReadiness(backend, url)
    const view = await backend.createView({ session, window, url, trust: { kind: 'remote' } })
    try {
      await waitFor(first.wait(view))
    } finally {
      first.close()
    }
    phase = 'grant-denial'
    await assert.rejects(backend.captureScreenshot(view), /permission|grant/i)
    await assert.rejects(backend.evaluate(view, 'document.title'), /permission|grant/i)
    checks['ungrantedDenied'] = true
    const oldScope = await grant(view, { name: 'browser-snapshot' })
    for (const name of [
      'browser-observe-dom',
      'browser-observe-accessibility',
      'browser-input',
    ] as const)
      await grant(view, { name })
    phase = 'screenshot'
    const image = await waitFor(
      backend.captureScreenshot(view, { maxWidth: 128, maxHeight: 96, signal: controller.signal })
    )
    assert.equal(image.format, 'png')
    assert.ok(image.data.byteLength > 57 && image.data.byteLength <= 1024 * 1024)
    assert.ok(image.width > 0 && image.width <= 128 && image.height > 0 && image.height <= 96)
    screenshot = {
      bytes: image.data.byteLength,
      width: image.width,
      height: image.height,
      sha256: createHash('sha256').update(image.data).digest('hex'),
    }
    checks['png'] = true
    phase = 'approved-evaluation'
    assert.equal(await evaluate(view, 'document.title'), 'Browser action fixture')
    checks['approvedEvaluation'] = true
    phase = 'observations'
    const dom = await waitFor(backend.observeDom(view, { signal: controller.signal }))
    assert.ok(
      dom.nodes.length > 0 &&
        dom.nodes.length <= 256 &&
        dom.nodes.every((node) => node.depth <= 4 && [...node.name].length <= 512)
    )
    assert.equal(dom.truncated, true)
    try {
      const ax = await waitFor(backend.accessibilityTree(view, { signal: controller.signal }))
      assert.ok(ax.nodes.length > 0 && ax.nodes.length <= 256)
      accessibility = 'supported'
    } catch (error) {
      assert.match(String(error), /unsupported-capability|UNSUPPORTED_CAPABILITY/)
      accessibility = 'unsupported'
    }
    checks['boundedObservations'] = true
    phase = 'synthetic-input'
    await evaluate(view, 'document.getElementById("text").focus()')
    await waitFor(
      backend.input(view, { type: 'text', text: 'typed Ω' }, { signal: controller.signal })
    )
    assert.equal(await evaluate(view, 'document.getElementById("text").value'), 'typed Ω')
    await waitFor(
      backend.input(
        view,
        { type: 'pointer', x: 30, y: 60, button: 'left' },
        { signal: controller.signal }
      )
    )
    assert.deepEqual(
      await evaluate(
        view,
        '({clicks:document.body.dataset.clicks,trusted:document.body.dataset.trusted})'
      ),
      { clicks: '1', trusted: 'false' }
    )
    checks['syntheticInput'] = true
    phase = 'beforeinput-mutation'
    for (const mutation of ['password', 'disabled', 'readonly', 'button']) {
      await evaluate(
        view,
        `(()=>{const e=document.getElementById('text');e.type='text';e.disabled=false;e.readOnly=false;e.value='';document.body.dataset.mutation='${mutation}';e.focus();return true})()`
      )
      await assert.rejects(
        backend.input(view, { type: 'text', text: 'must-not-insert' }),
        /unsupported-capability/
      )
      assert.equal(await evaluate(view, 'document.getElementById("text").value'), '')
    }
    checks['beforeinputRevalidated'] = true
    phase = 'cross-origin-frame-create'
    await evaluate(
      view,
      `(()=>{const e=document.createElement('iframe');e.id='foreign';e.src=${JSON.stringify(child.url.origin)};document.body.append(e);return true})()`
    )
    phase = 'cross-origin-frame-load'
    await waitFor(childLoaded.promise)
    phase = 'cross-origin-frame-same-origin-policy'
    assert.equal(
      await evaluate(
        view,
        `(()=>{try{return document.getElementById('foreign').contentWindow.document.body.textContent==='FOREIGN_FRAME_SENTINEL'}catch{return false}})()`
      ),
      false
    )
    phase = 'cross-origin-frame-focus'
    await evaluate(view, 'document.getElementById("foreign").focus()')
    phase = 'cross-origin-frame-text'
    await assert.rejects(
      backend.input(view, { type: 'text', text: 'forbidden' }),
      /unsupported-capability/
    )
    phase = 'cross-origin-frame-pointer'
    await assert.rejects(
      backend.input(view, { type: 'pointer', x: 350, y: 150, button: 'left' }),
      /unsupported-capability/
    )
    phase = 'cross-origin-frame-dom'
    const framed = await backend.observeDom(view)
    assert.equal(
      framed.nodes.some((node) => node.text.includes('FOREIGN_FRAME_SENTINEL')),
      false
    )
    checks['crossOriginFrameDenied'] = true
    phase = 'oversized-results'
    await assert.rejects(backend.captureScreenshot(view, { maxWidth: 1025 }), /bound/)
    await grant(view, { name: 'browser-evaluate', expression: '"x".repeat(513)' })
    await assert.rejects(backend.evaluate(view, '"x".repeat(513)'), /payload-too-large/)
    await evaluate(
      view,
      `(()=>{const c=document.createElement('canvas');c.id='noise';c.width=1024;c.height=768;c.style='position:fixed;inset:0;z-index:100;width:1024px;height:768px';document.body.append(c);const x=c.getContext('2d'),d=x.createImageData(1024,768);let s=1;for(let i=0;i<d.data.length;i++){s^=s<<13;s^=s>>>17;s^=s<<5;d.data[i]=i%4===3?255:s&255}x.putImageData(d,0,0);requestAnimationFrame(()=>requestAnimationFrame(()=>fetch('/painted')));return true})()`
    )
    await waitFor(painted.promise)
    await assert.rejects(backend.captureScreenshot(view), /payload-too-large/)
    await evaluate(view, 'document.getElementById("noise").remove()')
    checks['oversizedResultsDenied'] = true
    phase = 'unauthorized-session'
    const other = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'browser-other',
      network: { allowedOrigins: [origin, child.url.origin] },
    })
    const otherReady = remoteDocumentReadiness(backend, origin + '/other')
    const otherView = await backend.createView({
      session: other,
      window,
      url: origin + '/other',
      trust: { kind: 'remote' },
    })
    try {
      await waitFor(otherReady.wait(otherView))
    } finally {
      otherReady.close()
    }
    await assert.rejects(backend.captureScreenshot(otherView), /permission|grant/i)
    await backend.disposeView(otherView)
    await backend.disposeSession(other)
    checks['otherSessionDenied'] = true
    const busy =
      '(()=>{const end=performance.now()+350;while(performance.now()<end){};return true})()'
    await grant(view, { name: 'browser-evaluate', expression: busy })
    phase = 'inflight-cancellation'
    const cancel = new AbortController()
    const cancelled = assert.rejects(
      backend.evaluate(view, busy, { signal: cancel.signal }),
      /abort|cancel/i
    )
    await admitted()
    cancel.abort()
    await cancelled
    await settled()
    checks['cancellationSettled'] = true
    phase = 'navigation-race'
    const racing = assert.rejects(
      backend.evaluate(view, busy),
      /stale|changed|revoked|cancel|document/i
    )
    await admitted()
    const oldDocument = backend.state(view).documentId
    url = origin + '/document?replacement'
    await ready(view, url, oldDocument)
    await racing
    await assert.rejects(
      backend.grantNativeCapability(oldScope, { name: 'browser-snapshot' }),
      /scope|document|stale|revoked/i
    )
    await assert.rejects(backend.captureScreenshot(view), /permission|grant/i)
    assert.equal(backend.state(view).trust.kind, 'remote')
    checks['navigationRevoked'] = true
    phase = 'close-with-owner'
    await grant(view, { name: 'browser-evaluate', expression: busy })
    const closing = assert.rejects(backend.evaluate(view, busy), /cancel|closed|disposed|stale/i)
    await admitted()
    await backend.disposeView(view)
    await closing
    checks['closeSettled'] = true
    phase = 'session-release'
    await backend.disposeSession(session)
    // Keep the empty window alive until native ownership has been observed.
    // Closing the last window starts host shutdown and ends the private pipe.
    phase = 'native-settlement'
    nativeSettled = await settled()
    checks['zeroOwners'] = true
    phase = 'window-close'
    await backend.closeWindow(window)
  } catch (error) {
    const code = /Browser action failed: ([a-z-]+)/.exec(String(error))?.[1]
    failure = `${phase}:${error instanceof Error ? error.name : 'Error'}${code ? ':' + code : ''}`
  } finally {
    clearTimeout(deadline)
    try {
      await backend.dispose()
    } catch {
      failure ??= 'shutdown:Error'
    }
    await server.stop(true)
    await child.stop(true)
    const final = backend.diagnostics()
    for (const key of ['views', 'windows', 'sessions', 'listeners', 'listenerErrors'] as const)
      if (final[key] !== 0) failure ??= `final-${key}:Error`
    if (controller.signal.aborted || performance.now() - started >= 45_000)
      failure ??= 'workload-deadline:Error'
    console.error(
      JSON.stringify({
        event: 'bunly.native.browser-actions',
        schema: 1,
        passed: failure === null,
        failure,
        workloadMs: performance.now() - started,
        checks,
        screenshot,
        accessibility,
        nativeSettled,
        final,
        syntheticInput: true,
        trustedInputQualified: false,
        performanceEligible: false,
      })
    )
  }
  if (failure) throw new Error(failure)
}

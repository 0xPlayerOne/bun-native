import { expect, test } from 'bun:test'
import {
  createWorkbenchDesktopProbe,
  verifyWorkbenchCompletion,
  type WorkbenchDesktopProbe,
} from '../benchmarks/lib/workbench-desktop.ts'
import { createDesktopProbe } from '../benchmarks/lib/desktop-probe.ts'
import { fixtureBytes, checksum } from '../benchmarks/fixtures/data.ts'

// These assets deliberately do not render: tests exercise the actual HTTP
// composition and validators, not a claim that Chromium/xterm ran here.
const assets = {
  html: '<!doctype html><body>protocol test</body>',
  script: 'void 0;',
  terminalJs: 'void 0;',
  terminalCss: 'body{}',
}
const options = {
  revision: 'initial',
  state: 'state',
  counter: 7,
  framework: 'fixture',
  version: '1',
  html: '<!doctype html><body></body>',
  javascript: 'void 0;',
  timeoutMs: 1500,
}
function terminal() {
  const bytes = fixtureBytes()
  return {
    scenario: 'terminal-render',
    passed: true,
    nativeGlobalsAbsent: true,
    bytes: bytes.length,
    checksum: checksum(bytes),
    terminalConsumedThenTwoFramesMs: 12,
  }
}
async function page(probe: WorkbenchDesktopProbe) {
  const response = await fetch(probe.configuration.origin)
  const html = await response.text()
  const match = /<iframe[^>]+src="([^"]+)"/.exec(html)
  if (!match) throw new Error('No shared frame')
  return {
    frame: new URL(match[1]!),
    csp: response.headers.get('content-security-policy') ?? '',
    html,
  }
}
async function hostAndPage(probe: WorkbenchDesktopProbe): Promise<void> {
  const { origin, hostToken, rendererToken, launch } = probe.configuration
  const host = await fetch(origin + '/host', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bunly-probe-token': hostToken },
    body: JSON.stringify({
      launch,
      revision: 'initial',
      instance: 'instance',
      state: 'state',
      counter: 7,
      pid: 1,
      framework: 'fixture',
      frameworkVersion: '1',
      runtimeVersion: '1.4.4',
      engineVersion: null,
      sandbox: 'unverified',
    }),
  })
  expect(host.status).toBe(202)
  const renderer = await fetch(origin + '/renderer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bunly-probe-token': rendererToken, origin },
    body: JSON.stringify({
      launch,
      revision: 'initial',
      document: 'document',
      state: 'state',
      counter: 7,
      nativeGlobalsAbsent: true,
      frameOpportunities: 2,
    }),
  })
  expect(renderer.status).toBe(202)
}
async function finish(frame: URL, result: unknown): Promise<Response> {
  return fetch(frame.origin + '/__benchmark/completion', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-benchmark-token': frame.searchParams.get('completionToken')!,
      origin: frame.origin,
    },
    body: JSON.stringify(result),
  })
}
test('terminal completion requires exact workload bytes and checksum, not just readiness', () => {
  expect(verifyWorkbenchCompletion(terminal()).bytes).toBe(fixtureBytes().length)
  for (const change of [
    { bytes: 0 },
    { checksum: 0 },
    { passed: false },
    { scenario: 'app-launch' },
    { nativeGlobalsAbsent: false },
    { terminalConsumedThenTwoFramesMs: -1 },
  ]) {
    expect(() => verifyWorkbenchCompletion({ ...terminal(), ...change })).toThrow()
  }
  expect(
    Object.hasOwn(verifyWorkbenchCompletion({ ...terminal(), secret: 'not retained' }), 'secret')
  ).toBe(false)
})
test('composed desktop serves full shared assets under an exact separate frame origin', async () => {
  const probe = await createWorkbenchDesktopProbe(options, assets)
  try {
    const view = await page(probe)
    expect(view.frame.origin).not.toBe(probe.configuration.origin)
    expect(view.csp).toContain('frame-src ' + view.frame.origin)
    expect(view.csp).toContain("frame-ancestors 'none'")
    expect(view.html).toContain('sandbox="allow-scripts allow-same-origin allow-forms"')
    expect(view.html).not.toContain(probe.configuration.hostToken)
    expect(view.html).not.toContain(probe.configuration.rendererToken)
    expect(await (await fetch(view.frame.origin + '/vendor/xterm.js')).text()).toBe(
      assets.terminalJs
    )
    expect(await (await fetch(view.frame.origin + '/ui.js')).text()).toBe(assets.script)
  } finally {
    await probe.close()
  }
})
test('revision readiness alone cannot pass; terminal completion is independently required', async () => {
  const probe = await createWorkbenchDesktopProbe(options, assets)
  try {
    const view = await page(probe)
    let completed = false
    void probe.completion.then(() => {
      completed = true
    })
    await hostAndPage(probe)
    await Bun.sleep(5)
    expect(completed).toBe(false)
    expect((await finish(view.frame, terminal())).status).toBe(202)
    expect((await probe.completion).workbench.checksum).toBe(checksum(fixtureBytes()))
  } finally {
    await probe.close()
  }
})
test('terminal acknowledgement alone cannot pass before the host and revision document', async () => {
  const probe = await createWorkbenchDesktopProbe(options, assets)
  try {
    const view = await page(probe)
    await finish(view.frame, terminal())
    await hostAndPage(probe)
    expect((await probe.completion).renderer.document).toBe('document')
  } finally {
    await probe.close()
  }
})
test('dropped terminal bytes reject the combined launch even when revision checks pass', async () => {
  const probe = await createWorkbenchDesktopProbe(options, assets)
  try {
    const view = await page(probe)
    await hostAndPage(probe)
    await finish(view.frame, { ...terminal(), bytes: 1 })
    await expect(probe.completion).rejects.toThrow('terminal workload')
  } finally {
    await probe.close()
  }
})
test('missing terminal completion has a finite deadline and no passing zero value', async () => {
  // Admit the real HTTP host/page before advancing the fixture deadline.
  // Wall-clock load must not turn this into an unrelated handshake timeout.
  const pending = new Map<() => void, number>()
  const probe = await createWorkbenchDesktopProbe(
    { ...options, timeoutMs: 100 },
    assets,
    (callback, milliseconds) => {
      pending.set(callback, milliseconds)
      return () => {
        pending.delete(callback)
      }
    }
  )
  try {
    expect([...pending.values()]).toEqual([100, 100])
    await hostAndPage(probe)
    // The renderer deadline was cancelled; only terminal readiness is missing.
    expect(pending.size).toBe(1)
    const expire = [...pending.keys()][0]!
    expire()
    await expect(probe.completion).rejects.toThrow()
    expect(pending.size).toBe(0)
  } finally {
    await probe.close()
    expect(pending.size).toBe(0)
  }
})
test('ordinary workbench probing still expires with real timers', async () => {
  const probe = await createWorkbenchDesktopProbe({ ...options, timeoutMs: 100 }, assets)
  try {
    await expect(probe.completion).rejects.toThrow()
  } finally {
    await probe.close()
  }
})
test('closing stops both private servers and can be repeated', async () => {
  const probe = await createWorkbenchDesktopProbe(options, assets)
  const view = await page(probe)
  const first = probe.close()
  const second = probe.close()
  expect(first).toBe(second)
  await first
  await expect(probe.completion).rejects.toThrow()
  await expect(fetch(view.frame.origin)).rejects.toThrow()
  await expect(fetch(probe.configuration.origin)).rejects.toThrow()
})
test('a renderer credential from one role or launch cannot complete another workload', async () => {
  const probe = await createWorkbenchDesktopProbe(options, assets)
  try {
    const view = await page(probe)
    const response = await fetch(view.frame.origin + '/__benchmark/completion', {
      method: 'POST',
      headers: {
        origin: view.frame.origin,
        'content-type': 'application/json',
        'x-benchmark-token': probe.configuration.rendererToken,
      },
      body: JSON.stringify(terminal()),
    })
    expect(response.status).toBe(403)
  } finally {
    await probe.close()
  }
})
test('missing real-renderer assets and non-loopback frame grants are rejected', async () => {
  await expect(createWorkbenchDesktopProbe(options, { ...assets, terminalJs: '' })).rejects.toThrow(
    'complete shared workbench'
  )
  for (const frameOrigin of [
    'https://untrusted.example',
    'http://localhost:1234',
    'http://127.0.0.1:1234/path',
    'http://127.0.0.1',
  ]) {
    await expect(createDesktopProbe({ ...options, frameOrigin })).rejects.toThrow()
  }
})

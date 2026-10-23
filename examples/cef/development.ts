import assert from 'node:assert/strict'
import { nativePolicyCallbacks } from '../../benchmarks/lib/cef-policy-acceptance.ts'
import { pageTimeout } from './page-readiness.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
export default async function development(backend: CefBackend): Promise<void> {
  const origin = process.env['BUNLY_TEST_ORIGIN']
  const denied = process.env['BUNLY_TEST_DENIED_ORIGIN']
  if (!origin || !denied) throw new Error('Explicit private development fixture origins required')
  const diagnostics = (await backend.nativeDiagnostics()) as Record<string, unknown>
  assert.equal(
    diagnostics['policyFixtureMedia'],
    true,
    'Native synthetic media fixture was not enabled'
  )
  const session = await backend.createSession({
    partition: 'development-test',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'Bunly local origin qualification',
    bounds: { x: 10, y: 10, width: 700, height: 500 },
  })
  let readyYes!: () => void,
    nativeReadyYes!: () => void,
    popupYes!: () => void,
    yes!: () => void,
    no!: (error: Error) => void
  const ready = new Promise<void>((ok) => {
    readyYes = ok
  })
  const nativeReady = new Promise<void>((ok) => {
    nativeReadyYes = ok
  })
  const popupReady = new Promise<void>((ok) => {
    popupYes = ok
  })
  const loaded = new Promise<void>((ok, bad) => {
    yes = ok
    no = bad
  })
  let lastStage = 'created'
  const policyCallbacks = new Set<string>()
  const expectedCallbacks = nativePolicyCallbacks

  void loaded.catch(() => {})
  const listener = backend.observe((event) => {
    if (event.event === 'view.loaded') nativeReadyYes()
    if (event.event.startsWith('policy.')) policyCallbacks.add(event.event)
    if (event.event !== 'view.console') return
    const text = String(event.data?.['message'])
    if (text.startsWith('DEV_POLICY_STAGE:'))
      lastStage = text.slice('DEV_POLICY_STAGE:'.length, 128)
    if (text === 'DEV_POPUP_READY') {
      lastStage = 'popup-ready'
      popupYes()
    } else if (text === 'DEV_READY') readyYes()
    else if (text === 'DEV_TEST_OK') yes()
    else if (text.startsWith('DEV_TEST_FAILED:')) no(new Error(text))
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const view = await backend.createView({
      window,
      session,
      url: origin + '/',
      trust: { kind: 'remote' },
    })
    deadline = setTimeout(
      () =>
        no(
          new Error(
            `Development page did not complete: stage=${lastStage}; callbacks=${[...policyCallbacks].join(',')}`
          )
        ),
      process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'] === undefined
        ? 12000
        : pageTimeout(process.env['BUNLY_TEST_PAGE_TIMEOUT_MS'])
    )
    await Promise.race([
      Promise.all([ready, nativeReady]),
      loaded.then(() => {
        throw new Error('Page finished before policy setup')
      }),
    ])
    lastStage = 'native-ready'
    // This is trusted backend configuration over the inherited native pipe.
    // The same-origin child still cannot reuse this main-document grant because
    // CEF's generic prompt callback does not attest a requesting frame.
    const policyScope = await backend.capturePolicyScope(view)
    lastStage = 'scope-captured'
    await backend.setBrowserApplicationPolicy(policyScope, 'geolocation', 'granted')
    lastStage = 'policy-granted'
    const armed = await fetch(origin + '/arm', { method: 'POST' })
    assert.equal(armed.ok, true, 'Could not arm the native policy callback fixture')
    await Promise.race([popupReady, loaded])
    await backend.focusView(view)
    await backend.qualifyPolicyGesture(policyScope)
    lastStage = 'activation-dispatched'
    await loaded
    const missingCallbacks = expectedCallbacks.filter((event) => !policyCallbacks.has(event))
    if (missingCallbacks.length)
      throw new Error(
        'Missing native policy callbacks: ' +
          missingCallbacks.join(',') +
          '; observed=' +
          [...policyCallbacks].sort().join(',')
      )
    const next = await backend.navigate(view, origin + '/allowed-redirect')
    assert.equal(next.url, origin + '/next')
    await assert.rejects(
      backend.recordBrowserUserDecision(policyScope, 'camera', 'granted'),
      /stale/
    )
    await assert.rejects(backend.navigate(view, denied + '/main'))
    await assert.rejects(backend.navigate(view, origin + '/denied-redirect'))
    const recovery = await backend.navigate(view, origin + '/next')
    assert.equal(recovery.url, origin + '/next')
    console.error(
      JSON.stringify({
        event: 'bunly.native.development',
        schema: 3,
        passed: true,
        scopeRevoked: true,
        activation: 'native-fixed-fixture',
        mediaDevices: 'synthetic-device-real-permission-callback',
        policyCallbacks: expectedCallbacks,
      })
    )
  } finally {
    if (deadline) clearTimeout(deadline)
    listener()
    await backend.dispose()
  }
}

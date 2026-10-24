/** Synthetic cookies only; actual native persistence and remote-view isolation. */
import assert from 'node:assert/strict'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { SessionHandle } from '../../packages/contracts/src/index.ts'

export default async function credentials(backend: CefBackend): Promise<void> {
  Error.stackTraceLimit = 3
  const mode = process.env['BUNLY_CREDENTIAL_MODE']
  const root = process.env['BUNLY_PROFILE_ROOT']!
  const origin = process.env['BUNLY_CREDENTIAL_ORIGIN']!
  assert.ok(
    ['seed', 'present', 'clear', 'cleared', 'unavailable', 'intent-denied'].includes(String(mode))
  )
  let browserChecks = 0
  try {
    const create = (partition: string, protectedCookies = true) =>
      backend.createSession({
        persistence: 'persistent',
        partition,
        persistentRoot: root,
        ...(protectedCookies ? { persistentCookies: 'os-protected' as const } : {}),
        network: { allowedOrigins: [origin] },
      })
    if (mode === 'unavailable' || mode === 'intent-denied') {
      await assert.rejects(
        create('A', mode !== 'intent-denied'),
        mode === 'unavailable'
          ? { code: 'UNSUPPORTED_CAPABILITY' }
          : /Protected cookie profile cannot be opened/
      )
      const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
      assert.equal(native['sessions'], 0)
      assert.equal(native['credentialProviderReady'], false)
      assert.equal(backend.diagnostics().sessions, 0)
      console.error(
        JSON.stringify({
          event: 'bunly.native.credentials',
          schema: 1,
          mode,
          passed: true,
          admitted: false,
          browserChecks: 0,
          applicationSessions: 0,
        })
      )
      return
    }
    const a = await create('A'),
      b = await create('B')
    const e = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'E',
      network: { allowedOrigins: [origin] },
    })
    const window = await backend.createWindow({
      title: 'Bunly credential qualification',
      bounds: { x: 10, y: 10, width: 600, height: 400 },
    })
    const values = async (session: SessionHandle) =>
      (await backend.cookies(session, { url: origin })).filter(
        (cookie) => cookie.name === 'bunly_credential_fixture'
      )
    const write = (session: SessionHandle, value: string) =>
      backend.setCookie(session, origin, {
        name: 'bunly_credential_fixture',
        value,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        expires: Date.now() + 3600000,
      })
    if (mode === 'seed') {
      for (const session of [a, b, e]) assert.deepEqual(await values(session), [])
      await write(a, 'A')
      await write(b, 'B')
      await write(e, 'E')
    }
    if (mode === 'clear') {
      assert.equal((await values(a))[0]?.value, 'A')
      const cleared = await backend.clearSession(a, { cookies: true, cache: true })
      assert.equal(cleared.cookiesDeleted, 1)
      assert.equal(cleared.cacheCleared, true)
      assert.equal(cleared.storageCleared, false)
    }
    for (const [session, name, present] of [
      [a, 'A', mode !== 'clear' && mode !== 'cleared'],
      [b, 'B', true],
      [e, 'E', mode === 'seed'],
    ] as const) {
      const cookies = await values(session)
      assert.equal(cookies.length, present ? 1 : 0)
      if (present) {
        assert.equal(cookies[0]!.value, name)
        assert.equal(cookies[0]!.httpOnly, true)
      }
      const marker = `BUNLY_CREDENTIAL_BROWSER:${name}:${present ? 'present' : 'empty'}`
      let off = () => {},
        timer: ReturnType<typeof setTimeout> | undefined
      const ready = new Promise<void>((resolve, reject) => {
        off = backend.observe((event) => {
          if (event.event !== 'view.console') return
          if (event.data?.['message'] === marker) resolve()
          if (String(event.data?.['message']).startsWith('BUNLY_CREDENTIAL_BROWSER_FAILED'))
            reject(new Error('Native credential browser fixture failed'))
        })
        timer = setTimeout(
          () => reject(new Error('Native credential browser receipt missing')),
          10000
        )
      })
      void ready.catch(() => {})
      try {
        const view = await backend.createView({
          session,
          window,
          url: `${origin}/?partition=${name}&expected=${present ? 'present' : 'empty'}`,
          trust: { kind: 'remote' },
        })
        await ready
        assert.equal(backend.state(view).trust.kind, 'remote')
        browserChecks++
        await backend.disposeView(view)
      } finally {
        off()
        clearTimeout(timer)
      }
      await backend.flushSession(session)
      await backend.disposeSession(session)
    }
    const native = (await backend.nativeDiagnostics()) as Record<string, unknown>
    assert.equal(native['sessions'], 0)
    assert.equal(native['views'], 0)
    assert.equal(native['credentialProbeContexts'], 0)
    assert.equal(native['credentialProviderReady'], true)
    assert.equal(backend.diagnostics().listeners, 0)
    console.error(
      JSON.stringify({
        event: 'bunly.native.credentials',
        schema: 1,
        mode,
        passed: true,
        admitted: true,
        browserChecks,
        applicationSessions: 0,
      })
    )
  } finally {
    await backend.dispose()
  }
}

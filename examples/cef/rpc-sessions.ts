import assert from 'node:assert/strict'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { SessionHandle, ViewHandle, WindowHandle } from '../../packages/contracts/src/index.ts'
import { focusWhenReady } from './focus-readiness.ts'

interface Pending {
  readonly started: boolean
  readonly aborted: boolean
  readonly viewId: string
}
interface Waiter {
  readonly promise: Promise<void>
  close(): void
}

/** Real CEF integration: opaque session/view owners, not page-claimed IDs.
 * The existing wait handler records its native-bound view identity and resolves
 * late on revocation. The outer fixture rejects any stale renderer delivery.
 */
export async function qualifyRpcSessions(
  backend: CefBackend,
  window: WindowHandle,
  primary: ViewHandle,
  primarySession: SessionHandle,
  consoleWait: (marker: string) => Waiter,
  pending: (mode: string) => Pending | undefined,
  pageDeadlineMs = 10000
): Promise<void> {
  const views: ViewHandle[] = []
  const sessions: SessionHandle[] = []
  const url = 'https://rpc-session-fixture.invalid/'
  const query = { url }
  const cookie = { name: 'rpc-owner', secure: true, httpOnly: true, sameSite: 'strict' as const }
  async function start(session: SessionHandle, mode: string, remote = false): Promise<ViewHandle> {
    const ready = consoleWait(
      remote ? 'BUNLY_RPC_UNPRIVILEGED' : 'BUNLY_RPC_LIFECYCLE_STARTED:' + mode
    )
    try {
      const view = await backend.createView({
        window,
        session,
        url: 'app://ui/rpc-lifecycle.html?mode=' + (remote ? 'unprivileged' : mode),
        trust: remote ? { kind: 'remote' } : { kind: 'application', origin: 'app://ui' },
      })
      views.push(view)
      await ready.promise
      assert.equal(backend.session(view), session)
      if (!remote) {
        assert.equal(pending(mode)?.started, true)
        assert.equal(
          pending(mode)?.viewId,
          view.id,
          'RPC identity escaped its native session/view owner'
        )
      }
      return view
    } finally {
      ready.close()
    }
  }
  async function close(view: ViewHandle, mode?: string): Promise<void> {
    await backend.disposeView(view)
    if (mode) assert.equal(pending(mode)?.aborted, true, 'Session retirement did not abort its RPC')
    assert.equal(backend.diagnostics().windows, 1)
    assert.equal(backend.state(primary).trust.kind, 'application')
  }
  try {
    await backend.setCookie(primarySession, url, { ...cookie, value: 'primary' })
    const shared = await start(primarySession, 'session-shared')
    const isolated = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'rpc-isolated',
    })
    sessions.push(isolated)
    const foreign = await start(isolated, 'session-isolated')
    assert.deepEqual(await backend.cookies(isolated, query), [])
    await backend.setCookie(isolated, url, { ...cookie, value: 'isolated' })
    assert.equal((await backend.cookies(primarySession, query))[0]?.value, 'primary')
    assert.equal((await backend.cookies(isolated, query))[0]?.value, 'isolated')
    await assert.rejects(backend.disposeSession(isolated), { code: 'RESOURCE_IN_USE' })
    await close(shared, 'session-shared')
    await close(foreign, 'session-isolated')
    await backend.disposeSession(isolated)

    const replacement = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'rpc-isolated',
    })
    sessions.push(replacement)
    assert.notEqual(replacement, isolated)
    await assert.rejects(backend.cookies(isolated, query))
    assert.deepEqual(await backend.cookies(replacement, query), [])
    // Reusing a partition/origin does not restore authority to a remote view.
    const remote = await start(replacement, 'unprivileged', true)
    assert.equal(backend.state(remote).trust.kind, 'remote')
    await close(remote)
    // A new explicitly trusted view receives its own independently bound lease.
    const current = await start(replacement, 'session-replacement')
    assert.notEqual(current.id, foreign.id)
    await close(current, 'session-replacement')
    await backend.disposeSession(replacement)
    assert.equal((await backend.cookies(primarySession, query))[0]?.value, 'primary')
    assert.equal(await backend.deleteCookies(primarySession, { url, name: cookie.name }), 1)
    assert.equal(backend.diagnostics().sessions, 1)
    assert.equal(backend.diagnostics().views, 1)
    await focusWhenReady(backend, primary, 'sessions-closed', pageDeadlineMs)
  } finally {
    // Only this fixture's handles; never delete or reuse a native profile path.
    for (const view of views.reverse()) await backend.disposeView(view).catch(() => {})
    for (const session of sessions.reverse()) await backend.disposeSession(session).catch(() => {})
  }
}

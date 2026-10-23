import assert from 'node:assert/strict'
import { lstat, writeFile } from 'node:fs/promises'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import type { SessionHandle } from '../../packages/contracts/src/index.ts'

const timeoutMs = 20_000

export default async function sessions(backend: CefBackend): Promise<void> {
  const mode = process.env['BUNLY_SESSION_FIXTURE']
  const persistentRoot = process.env['BUNLY_PROFILE_ROOT']
  if (
    !['ephemeral', 'persistent-write', 'persistent-read', 'cookies', 'lock-hold'].includes(
      mode ?? ''
    )
  )
    throw new Error('Explicit BUNLY_SESSION_FIXTURE mode required')

  async function page(session: SessionHandle, operation: 'read' | 'write', value?: string) {
    const window = await backend.createWindow({
      title: 'Bunly session fixture',
      bounds: { x: 10, y: 10, width: 480, height: 320 },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let finish!: (value: string | null) => void
    let fail!: (error: Error) => void
    const result = new Promise<string | null>((resolve, reject) => {
      finish = resolve
      fail = reject
      timer = setTimeout(() => reject(new Error('Session page deadline exceeded')), timeoutMs)
    })
    const detach = backend.observe((event) => {
      if (event.event !== 'view.console') return
      const message = String(event.data?.['message'] ?? '')
      if (!message.startsWith('BUNLY_SESSION_RESULT:')) return
      try {
        const parsed = JSON.parse(message.slice('BUNLY_SESSION_RESULT:'.length)) as {
          operation: string
          key: string
          value: string | null
        }
        if (parsed.operation === operation && parsed.key === 'isolation') finish(parsed.value)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    try {
      const query = new URLSearchParams({ operation, key: 'isolation' })
      if (value !== undefined) query.set('value', value)
      await backend.createView({
        window,
        session,
        url: `app://ui/session.html?${query}`,
        trust: { kind: 'application', origin: 'app://ui' },
      })
      return await result
    } finally {
      if (timer) clearTimeout(timer)
      detach()
      await backend.closeWindow(window)
    }
  }

  try {
    await backend.createWindow({
      title: 'Bunly session qualification owner',
      bounds: { x: 20, y: 20, width: 320, height: 240 },
    })
    if (mode === 'ephemeral') {
      const shared = await backend.createSession({ persistence: 'ephemeral', partition: 'shared' })
      const isolated = await backend.createSession({
        persistence: 'ephemeral',
        partition: 'isolated',
      })
      assert.equal(await page(shared, 'write', 'shared-value'), 'shared-value')
      assert.equal(await page(shared, 'read'), 'shared-value')
      assert.equal(await page(isolated, 'read'), null)
      await backend.disposeSession(shared)
      const replacement = await backend.createSession({
        persistence: 'ephemeral',
        partition: 'shared',
      })
      assert.equal(await page(replacement, 'read'), null)
      await backend.disposeSession(replacement)
      await backend.disposeSession(isolated)
    } else if (mode === 'cookies') {
      const session = await backend.createSession({
        persistence: 'ephemeral',
        partition: 'cookies',
      })
      await backend.setCookie(session, 'https://session-fixture.invalid/', {
        name: 'bounded',
        value: 'private-value',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
      })
      const cookies = await backend.cookies(session, { url: 'https://session-fixture.invalid/' })
      assert.equal(cookies.find((cookie) => cookie.name === 'bounded')?.value, 'private-value')
      const other = await backend.createSession({
        persistence: 'ephemeral',
        partition: 'cookies-other',
      })
      assert.deepEqual(
        await backend.cookies(other, { url: 'https://session-fixture.invalid/' }),
        []
      )
      await backend.disposeSession(other)
      assert.equal(
        await backend.deleteCookies(session, {
          url: 'https://session-fixture.invalid/',
          name: 'bounded',
        }),
        1
      )
      assert.deepEqual(await backend.clearSession(session, { cache: true }), {
        cookiesDeleted: 0,
        cacheCleared: true,
        storageCleared: false,
      })
      await assert.rejects(backend.clearSession(session, { storage: true }), /storage-clear/)
      await backend.disposeSession(session)
    } else {
      assert.ok(persistentRoot, 'Persistent fixture requires an isolated BUNLY_PROFILE_ROOT')
      const session = await backend.createSession({
        persistence: 'persistent',
        partition: 'restart',
        persistentRoot,
      })
      if (mode === 'persistent-write' || mode === 'lock-hold')
        assert.equal(await page(session, 'write', 'restart-value'), 'restart-value')
      else assert.equal(await page(session, 'read'), 'restart-value')
      if (mode === 'persistent-write' || mode === 'persistent-read') {
        const other = await backend.createSession({
          persistence: 'persistent',
          partition: 'Restart',
          persistentRoot,
        })
        if (mode === 'persistent-write') {
          assert.equal(await page(other, 'read'), null)
          assert.equal(await page(other, 'write', 'other-profile-value'), 'other-profile-value')
        } else {
          assert.equal(await page(other, 'read'), 'other-profile-value')
        }
        assert.equal(await page(session, 'read'), 'restart-value')
        await backend.flushSession(other)
        await backend.disposeSession(other)
      }
      if (mode === 'lock-hold') {
        const ready = process.env['BUNLY_SESSION_READY']
        const release = process.env['BUNLY_SESSION_RELEASE']
        assert.ok(ready && release, 'Lock fixture requires private ready/release paths')
        await writeFile(ready, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
        const deadline = performance.now() + 60_000
        while (performance.now() < deadline) {
          if (await lstat(release).catch(() => undefined)) break
          await Bun.sleep(20)
        }
        assert.ok(await lstat(release).catch(() => undefined), 'Lock fixture release deadline')
      }
      await assert.rejects(backend.cookies(session), /app-specific credential identity/)
      await backend.clearSession(session, { cookies: false, cache: true })
      await backend.flushSession(session)
      await backend.disposeSession(session)
    }
    console.error(JSON.stringify({ event: 'bunly.native.sessions', mode, passed: true }))
    await backend.dispose()
  } catch (error) {
    await backend.dispose().catch(() => {})
    throw error
  }
}

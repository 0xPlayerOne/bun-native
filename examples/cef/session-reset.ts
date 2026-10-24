import assert from 'node:assert/strict'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

export default async function main(backend: CefBackend): Promise<void> {
  const root = process.env['BUNLY_PROFILE_ROOT']
  const origin = process.env['BUNLY_TEST_RESET_ORIGIN']
  const mode = process.env['BUNLY_TEST_RESET_MODE']
  assert.ok(
    root && origin && ['seed', 'present', 'cleared', 'hold', 'blocked'].includes(mode ?? '')
  )
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  const off = backend.observe((event) => {
    if (event.event !== 'view.console') return
    const message = event.data?.['message']
    if (typeof message !== 'string') return
    if (message.startsWith('BUNLY_RESET_STORAGE_OK:')) pending.get(message)?.resolve()
    if (message.startsWith('BUNLY_RESET_STORAGE_FAILED:'))
      for (const waiter of pending.values()) waiter.reject(new Error(message.slice(0, 1024)))
  })
  try {
    if (mode === 'blocked') {
      await assert.rejects(
        backend.createSession({ persistence: 'persistent', partition: 'A', persistentRoot: root }),
        /interrupted offline reset/
      )
    } else {
      const window = await backend.createWindow({
        title: 'Bunly offline storage reset fixture',
        bounds: { x: 10, y: 10, width: 640, height: 480 },
      })
      for (const role of ['A', 'B']) {
        const phase =
          mode === 'seed' ? 'seed' : mode === 'cleared' && role === 'A' ? 'empty' : 'present'
        const key = 'BUNLY_RESET_STORAGE_OK:' + role + ':' + phase
        let timer: ReturnType<typeof setTimeout> | undefined
        const ready = new Promise<void>((resolve, reject) => {
          pending.set(key, { resolve, reject })
          timer = setTimeout(
            () => reject(new Error('Actual storage fixture did not complete: ' + role)),
            10000
          )
        })
        void ready.catch(() => {})
        try {
          const session = await backend.createSession({
            persistence: 'persistent',
            partition: role,
            persistentRoot: root,
          })
          const view = await backend.createView({
            window,
            session,
            url: `${origin}/?role=${role}&mode=${phase}`,
            trust: { kind: 'remote' },
          })
          await ready
          await backend.disposeView(view)
          await backend.flushSession(session)
          await backend.disposeSession(session)
        } finally {
          if (timer) clearTimeout(timer)
          pending.delete(key)
        }
      }
      if (mode === 'hold') {
        const response = await fetch(origin + '/hold', { method: 'POST' })
        assert.equal(response.ok, true)
      }
    }
    console.error(
      JSON.stringify({
        event: 'bunly.native.session-reset',
        schema: 1,
        mode,
        passed: true,
        stores:
          mode === 'blocked' ? [] : ['localStorage', 'indexedDB', 'cacheStorage', 'serviceWorker'],
        nativeAuthority: 'remote-unprivileged',
      })
    )
  } finally {
    off()
    await backend.dispose()
  }
}

import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { NativeEvent } from '../packages/runtime/src/native-transport.ts'
import type { WindowHandle } from '../packages/contracts/src/index.ts'
import { awaitWindowMode } from '../examples/cef-terminal-load/window-modes.ts'
import {
  matchesLoadMode,
  requireLoadMode,
  type NativeLoadState,
} from '../examples/cef-terminal-load/mode-state.ts'
import { deferred } from '../examples/cef-terminal-load/probe.ts'
const foreground = {
  visible: true,
  active: true,
  minimized: false,
  maximized: false,
  fullscreen: false,
}
const window = Object.freeze({ kind: 'window', id: 'owned-fixture' }) as WindowHandle
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(read: () => Promise<NativeLoadState>) {
  const listeners = new Set<(event: NativeEvent) => void>()
  return {
    backend: {
      windowState: async (handle: WindowHandle) => {
        assert.equal(handle, window)
        return read()
      },
      observe: (listener: (event: NativeEvent) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    emit: () => {
      for (const listener of listeners)
        listener({ v: 1, event: 'window.state-changed', target: 999, data: foreground })
    },
    listeners,
  }
}
test('window-load modes cannot interchange visible, active, hidden or minimized receipts', () => {
  assert.ok(matchesLoadMode('foreground', foreground))
  assert.ok(matchesLoadMode('background', { ...foreground, active: false }))
  assert.ok(matchesLoadMode('hidden', { ...foreground, visible: false, active: false }))
  assert.ok(matchesLoadMode('minimized', { ...foreground, minimized: true, active: false }))
  assert.ok(!matchesLoadMode('foreground', { ...foreground, active: false }))
  assert.ok(!matchesLoadMode('background', foreground))
  assert.ok(!matchesLoadMode('minimized', { ...foreground, visible: false, active: false }))
  assert.ok(!matchesLoadMode('hidden', { ...foreground, minimized: true, active: false }))
  assert.throws(() =>
    requireLoadMode('minimized', { ...foreground, minimized: true, active: false }, 'visible')
  )
  assert.throws(() => requireLoadMode('background', foreground, 'visible'))
  for (const value of [null, {}, [], { ...foreground, active: 1 }, { ...foreground, pid: 12 }])
    assert.throws(() => matchesLoadMode('foreground', value))
})
test('mode waiting uses exact-handle native readback, not a foreign notification or action intent', async () => {
  let state = { ...foreground, active: false },
    reads = 0
  const f = fixture(async () => {
    reads++
    return state
  })
  const abort = new AbortController()
  const result = awaitWindowMode(
    f.backend,
    window,
    'foreground',
    () => 'visible',
    async () => {
      f.emit()
    },
    abort.signal
  )
  await turn()
  assert.equal(reads, 1)
  f.emit()
  await turn()
  assert.equal(reads, 2)
  state = foreground
  f.emit()
  assert.deepEqual(await result, {
    mode: 'foreground',
    nativeState: foreground,
    visibility: 'visible',
  })
  assert.equal(f.listeners.size, 0)
})
test('pending state queries coalesce notification bursts without unbounded promise fanout', async () => {
  const held = deferred<NativeLoadState>()
  let reads = 0
  const f = fixture(async () => (++reads === 1 ? held.promise : foreground))
  const result = awaitWindowMode(
    f.backend,
    window,
    'foreground',
    () => 'visible',
    async () => {}
  )
  await turn()
  for (let i = 0; i < 1000; i++) f.emit()
  assert.equal(reads, 1)
  held.resolve({ ...foreground, active: false })
  await result
  assert.equal(reads, 2)
  assert.equal(f.listeners.size, 0)
})
test('native mode observation cannot ignore missing page visibility and cancellation removes listeners', async () => {
  let reads = 0
  const f = fixture(async () => {
    reads++
    return { ...foreground, minimized: true, active: false }
  })
  const controller = new AbortController()
  const result = awaitWindowMode(
    f.backend,
    window,
    'minimized',
    () => 'visible',
    async () => {},
    controller.signal
  )
  const rejected = assert.rejects(result, /stop mode/)
  await turn()
  assert.equal(reads, 1)
  controller.abort(new Error('stop mode'))
  await rejected
  const count = reads
  f.emit()
  await turn()
  assert.equal(reads, count)
  assert.equal(f.listeners.size, 0)
})
test('mode cancellation also settles while a requested action never resolves', async () => {
  const f = fixture(async () => foreground),
    controller = new AbortController(),
    action = deferred<void>()
  const result = awaitWindowMode(
    f.backend,
    window,
    'foreground',
    () => 'visible',
    () => action.promise,
    controller.signal
  )
  const rejected = assert.rejects(result, /cancel action/)
  controller.abort(new Error('cancel action'))
  await rejected
  assert.equal(f.listeners.size, 0)
  action.resolve()
  await turn()
  assert.equal(f.listeners.size, 0)
})
test('mode action rejection and pre-aborted lifetimes cannot claim readback or retain listeners', async () => {
  let actions = 0,
    reads = 0
  const f = fixture(async () => {
    reads++
    return foreground
  })
  await assert.rejects(
    awaitWindowMode(
      f.backend,
      window,
      'foreground',
      () => 'visible',
      async () => {
        throw new Error('action failed')
      }
    ),
    /action failed/
  )
  await assert.rejects(
    awaitWindowMode(
      f.backend,
      window,
      'foreground',
      () => 'visible',
      async () => {
        actions++
      },
      AbortSignal.abort(new Error('already cancelled'))
    ),
    /already cancelled/
  )
  assert.equal(actions, 0)
  assert.equal(reads, 0)
  assert.equal(f.listeners.size, 0)
})

test('windowed full-load evidence requires admission, every phase, and actual restoration', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./fixtures/terminal-window-load-acceptance.ts', import.meta.url)),
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(code, 0, error)
  assert.deepEqual(JSON.parse(out), {
    passed: true,
    modes: ['foreground', 'background', 'hidden', 'minimized'],
    legacyNotRelabeled: true,
  })
})

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ViewHandle } from '../packages/contracts/src/index.ts'
import type { CefViewFocusState } from '../packages/runtime/src/cef-view-focus-state.ts'
import { focusWhenReady } from '../examples/cef/focus-readiness.ts'
import { turn } from './helpers/native-peer.ts'

const ready: CefViewFocusState = Object.freeze({
  windowVisible: true,
  windowMinimized: false,
  viewVisible: true,
  viewDrawn: true,
  viewEnabled: true,
  viewFocusable: true,
  positiveBounds: true,
  presentationAllowsFocus: true,
  overlayAllowsFocus: true,
  eligible: true,
})
const view = Object.freeze({ kind: 'view', id: 'focus-fixture' }) as ViewHandle
function fixture(states: readonly CefViewFocusState[] = [ready]) {
  const timers = new Map<number, { callback: () => void; milliseconds: number }>()
  let next = 0
  let reads = 0
  const actions: string[] = []
  const reports: Parameters<NonNullable<Parameters<typeof focusWhenReady>[5]>>[0][] = []
  const timer = {
    set(callback: () => void, milliseconds: number) {
      timers.set(++next, { callback, milliseconds })
      return next
    },
    clear(handle: unknown) {
      timers.delete(handle as number)
    },
  }
  const backend: Parameters<typeof focusWhenReady>[0] = {
    async nativeViewFocusState(handle) {
      assert.equal(handle, view)
      actions.push('read')
      return states[Math.min(reads++, states.length - 1)]!
    },
    async focusView(handle) {
      assert.equal(handle, view)
      actions.push('focus')
    },
  }
  return {
    backend,
    timer,
    timers,
    actions,
    reports,
    run(timeout = 10000) {
      return focusWhenReady(backend, view, 'window-shown', timeout, timer, (value) =>
        reports.push(value)
      )
    },
    fire(milliseconds: number) {
      const entry = [...timers].find(([, value]) => value.milliseconds === milliseconds)
      assert.ok(entry, 'Expected a pending fixture timer')
      timers.delete(entry[0])
      entry[1].callback()
    },
  }
}

test('focus waits for observed native visibility, positive bounds and unclipped presentation', async () => {
  const f = fixture([
    { ...ready, windowVisible: false, eligible: false },
    { ...ready, positiveBounds: false, eligible: false },
    { ...ready, overlayAllowsFocus: false, eligible: false },
    { ...ready, viewFocusable: false, eligible: false },
    ready,
  ])
  const pending = f.run()
  for (let count = 1; count <= 4; count++) {
    await turn()
    assert.deepEqual(f.actions, Array(count).fill('read'))
    f.fire(16)
  }
  await pending
  assert.deepEqual(f.actions, ['read', 'read', 'read', 'read', 'read', 'focus'])
  assert.equal(f.timers.size, 0)
  assert.deepEqual(
    f.reports.map((row) => row.stage),
    ['readiness', 'complete']
  )
  assert.deepEqual(f.reports.at(-1)?.state, ready)
})

test('an immediately eligible native snapshot focuses exactly once without a fixed sleep', async () => {
  const f = fixture()
  await f.run()
  assert.deepEqual(f.actions, ['read', 'focus'])
  assert.equal(f.timers.size, 0)
})

test('an ineligible view reaches the original finite deadline without a focus attempt', async () => {
  const f = fixture([{ ...ready, viewDrawn: false, eligible: false }])
  const pending = f.run()
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Native focus fixture failed: window-shown/readiness')
    assert.match(String(error.cause), /deadline/)
    return true
  })
  await turn()
  f.fire(10000)
  await rejected
  assert.deepEqual(f.actions, ['read'])
  assert.equal(f.timers.size, 0)
  assert.equal(f.reports.at(-1)?.state?.viewDrawn, false)
})

test('late eligible readback cannot pass an expired readiness deadline', async () => {
  const f = fixture()
  let deliver!: (value: CefViewFocusState) => void
  let signal: AbortSignal | undefined
  f.backend.nativeViewFocusState = async (_view, options) => {
    signal = options?.signal
    return new Promise((resolve) => {
      deliver = resolve
    })
  }
  const pending = f.run()
  const rejected = assert.rejects(pending, /window-shown\/readiness/)
  f.fire(10000)
  assert.equal(signal?.aborted, true)
  deliver(ready)
  await rejected
  assert.deepEqual(f.actions, [])
  assert.equal(f.timers.size, 0)
})

test('a native focus rejection is classified and never retried after eligibility was observed', async () => {
  const f = fixture()
  const denial = new Error('PERMISSION_DENIED: view is hidden, clipped or nonfocusable')
  f.backend.focusView = async () => {
    f.actions.push('focus')
    throw denial
  }
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Native focus fixture failed: window-shown/focus')
    assert.equal(error.cause, denial)
    return true
  })
  assert.deepEqual(f.actions, ['read', 'focus'])
  assert.equal(f.reports.at(-1)?.stage, 'focus')
  assert.equal(f.timers.size, 0)
})

test('a stale or failed state read is fatal without waiting or issuing focus', async () => {
  const f = fixture()
  const stale = new Error('INVALID_HANDLE: view')
  f.backend.nativeViewFocusState = async () => {
    throw stale
  }
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.cause, stale)
    return true
  })
  assert.deepEqual(f.actions, [])
  assert.equal(f.timers.size, 0)
})

test('readiness timing inputs remain bounded before any native operation', async () => {
  const f = fixture()
  for (const value of [0, -1, 0.5, NaN, Infinity, 60001])
    await assert.rejects(f.run(value), /deadline/)
  assert.deepEqual(f.actions, [])
  assert.equal(f.timers.size, 0)
})

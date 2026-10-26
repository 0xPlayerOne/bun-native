import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  acceptWindowModeReceipt,
  acceptWindowModes,
} from '../benchmarks/lib/cef-window-acceptance.ts'

function receipt() {
  const modes = ['visible', 'hidden', 'shown', 'minimized', 'restored'].map((mode, sequence) => ({
    mode,
    state: {
      visible: sequence !== 1 && sequence !== 3,
      minimized: sequence === 3,
      active: false,
      maximized: false,
      fullscreen: false,
    },
    page: { sequence, visibility: sequence === 1 || sequence === 3 ? 'hidden' : 'visible' },
    actionState:
      sequence < 3
        ? null
        : { visible: true, minimized: false, active: false, maximized: false, fullscreen: false },
  }))
  return {
    schema: 1,
    passed: true,
    failure: null,
    modes,
    pages: modes.map((row) => row.page),
    actions: modes.slice(3).map((row) => ({ mode: row.mode, state: row.actionState })),
    nativeFinal: {
      views: 0,
      sessions: 0,
      windows: 1,
      pending: 0,
      nativeDeliveryPackets: 0,
      nativeDeliveryBytes: 0,
      rpcIncomingBytes: 0,
      streamIncomingBytes: 0,
    },
  }
}

test('window qualification uses fresh mode readback and independent visibility, not action intent or activation', () => {
  assert.equal(acceptWindowModeReceipt(receipt()).length, 5)
  const minimizedVisible = receipt()
  minimizedVisible.modes[3]!.state.visible = true
  assert.equal(acceptWindowModeReceipt(minimizedVisible).length, 5)
})

test('failed, partial, relabeled or malformed observations cannot qualify modes', () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => {
      r.passed = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.modes.pop()
    },
    (r: ReturnType<typeof receipt>) => {
      r.modes.reverse()
    },
    (r: ReturnType<typeof receipt>) => {
      r.modes[3]!.state.minimized = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.modes[1]!.state.visible = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.modes[4]!.state.minimized = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.pages[3]!.visibility = 'visible'
    },
    (r: ReturnType<typeof receipt>) => {
      r.pages[3]!.sequence = 2
    },
    (r: ReturnType<typeof receipt>) => {
      Object.assign(r.modes[3]!.state, { minimized: 'true' })
    },
    (r: ReturnType<typeof receipt>) => {
      Object.assign(r, { failure: 'UNSUPPORTED' })
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptWindowModeReceipt(value))
  }
  // A receipt alone is never proof of successful native process/teardown execution.
  assert.throws(() => acceptWindowModes(receipt()))
})

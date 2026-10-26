import assert from 'node:assert/strict'
import { parseCefWindowState } from '../../packages/runtime/src/cef-window-state.ts'
import { nativeEvents } from './cef-acceptance.ts'
import { assertCleanCommand, validateCommandObservation } from './observed-command.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'

export function acceptWindowModeReceipt(receipt: Record<string, unknown>) {
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  const modes = receipt['modes']
  const pages = receipt['pages']
  assert.ok(Array.isArray(modes) && Array.isArray(pages))
  assert.equal(modes.length, 5)
  assert.equal(pages.length, 5)
  assert.deepEqual(
    receipt['actions'],
    modes.slice(3).map((entry: Record<string, unknown>) => ({
      mode: entry['mode'],
      state: entry['actionState'],
    }))
  )
  assert.deepEqual(receipt['nativeFinal'], {
    views: 0,
    sessions: 0,
    windows: 1,
    pending: 0,
    nativeDeliveryPackets: 0,
    nativeDeliveryBytes: 0,
    rpcIncomingBytes: 0,
    streamIncomingBytes: 0,
  })
  const names = ['visible', 'hidden', 'shown', 'minimized', 'restored']
  return modes.map((entry: Record<string, unknown>, index: number) => {
    assert.equal(entry['mode'], names[index])
    const state = parseCefWindowState(entry['state'])
    assert.equal(state.minimized, index === 3)
    if (index !== 3) assert.equal(state.visible, index !== 1)
    assert.equal(state.fullscreen, false)
    assert.equal(state.maximized, false)
    const page = { sequence: index, visibility: index === 1 || index === 3 ? 'hidden' : 'visible' }
    assert.deepEqual(entry['page'], page)
    assert.deepEqual(pages[index], page)
    // Action acknowledgments are retained, but never used as transition evidence.
    if (index >= 3) parseCefWindowState(entry['actionState'])
    else assert.equal(entry['actionState'], null)
    return { mode: names[index], state, page }
  })
}

export function acceptWindowModes(input: unknown) {
  const observation = validateCommandObservation(input)
  assertCleanCommand(observation)
  requireNativeShutdown(observeNativeShutdown(observation))
  const events = nativeEvents(observation)
  const receipts = events.filter((row) => row['event'] === 'bunly.native.window-modes')
  assert.equal(receipts.length, 1, 'Missing or duplicate window-mode receipt')
  assert.ok(
    events.indexOf(receipts[0]!) <
      events.findIndex((row) => row['event'] === 'bunly.host.shutdown-phase')
  )
  assert.deepEqual(
    events.filter((row) => row['event'] === 'bunly.native.output-drained'),
    [
      {
        event: 'bunly.native.output-drained',
        schema: 1,
        frames: 0,
        ordinaryFrames: 0,
        retainedWireBytes: 0,
        ordinaryWireBytes: 0,
      },
    ]
  )
  return acceptWindowModeReceipt(receipts[0]!)
}

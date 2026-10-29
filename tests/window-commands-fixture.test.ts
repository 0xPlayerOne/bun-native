import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { CommandObservations } from '../examples/window-commands/observations.ts'

test('native command fixture consumes actual ordered callbacks that can precede its waiter', async () => {
  const controller = new AbortController()
  const observations = new CommandObservations(controller.signal)
  observations.receive({ type: 'menu-shown', sequence: 1 })
  observations.receive({ type: 'command', sequence: 2, command: 'record', source: 'menu' })
  observations.receive({ type: 'menu-closed', sequence: 3 })
  await observations.take('menu-shown')
  await observations.take('command', 'menu')
  await observations.take('menu-closed')
  observations.assertDrained()
  observations.close()
})

test('native command fixture rejects missing, extra, reordered and incorrectly attributed evidence', async () => {
  const controller = new AbortController()
  const observations = new CommandObservations(controller.signal)
  const missing = observations.take('menu-shown')
  controller.abort()
  await assert.rejects(missing, /aborted/)
  await assert.rejects(observations.take('menu-closed'), /aborted/)
  observations.close()
  for (const event of [
    { type: 'menu-closed', sequence: 1 } as const,
    { type: 'command', sequence: 1, command: 'record', source: 'shortcut' } as const,
  ]) {
    const queue = new CommandObservations(new AbortController().signal)
    queue.receive(event)
    await assert.rejects(queue.take('command', 'menu'), /order/)
    queue.close()
  }
  const extra = new CommandObservations(new AbortController().signal)
  extra.receive({ type: 'menu-shown', sequence: 1 })
  assert.throws(() => extra.assertDrained(), /unconsumed/)
  extra.close()
})

test('native command fixture keeps a bounded receipt budget and retires pending work', async () => {
  const queue = new CommandObservations(new AbortController().signal)
  for (let sequence = 1; sequence <= 33; sequence++) queue.receive({ type: 'menu-shown', sequence })
  assert.equal(queue.events.length, 32)
  await assert.rejects(queue.take('menu-shown'), /capacity/)
  queue.close()
  const closed = new CommandObservations(new AbortController().signal)
  const waiter = closed.take('menu-shown')
  await assert.rejects(closed.take('menu-shown'), /Concurrent/)
  closed.close()
  await assert.rejects(waiter, /closed/)
})

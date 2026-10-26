import { test, expect } from 'bun:test'
import { beginTerminalNegativeControl } from '../examples/cef-terminal/negative-control.ts'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
test('overload establishes actual withheld consumption before a coalesced producer burst', async () => {
  const events: string[] = [],
    held = deferred<void>()
  let consumerHeld = false
  await beginTerminalNegativeControl('overload', {
    arm: () => events.push('arm'),
    held: held.promise,
    pending: () => events.push('pending'),
    control: async (action) => {
      events.push(action)
      if (action === 'overload' && !consumerHeld)
        throw new Error('Whole burst exceeded source admission before any consumer could be held')
      if (action === 'stall') {
        consumerHeld = true
        events.push('held')
        held.resolve()
      }
    },
  })
  expect(events).toEqual(['arm', 'stall', 'held', 'pending', 'overload'])
})
test('a transport handoff is not evidence the consumer is already held', async () => {
  const held = deferred<void>(),
    events: string[] = []
  const result = beginTerminalNegativeControl('navigate', {
    arm: () => events.push('arm'),
    control: async (action) => {
      events.push(action)
    },
    held: held.promise,
    pending: () => events.push('pending'),
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(events).toEqual(['arm', 'stall'])
  held.resolve()
  await result
  expect(events).toEqual(['arm', 'stall', 'pending'])
})
test('failed initial delivery cannot publish a pending marker or trigger the overload burst', async () => {
  const events: string[] = []
  await expect(
    beginTerminalNegativeControl('overload', {
      arm: () => events.push('arm'),
      control: async (action) => {
        events.push(action)
        throw new Error('owned delivery failed')
      },
      held: Promise.resolve(),
      pending: () => events.push('pending'),
    })
  ).rejects.toThrow('owned delivery failed')
  expect(events).toEqual(['arm', 'stall'])
})

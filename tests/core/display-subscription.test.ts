import { expect, test } from 'bun:test'
import { DisplaySubscription } from '../../packages/core/src/display.ts'

test('a display subscription is live until revoked, which aborts its signal once', () => {
  const listener = () => {}
  const subscription = new DisplaySubscription(listener)
  expect(subscription.live).toBe(true)
  expect(subscription.current).toBe(listener)
  expect(subscription.controller.signal.aborted).toBe(false)
  subscription.revoke()
  subscription.revoke()
  expect(subscription.live).toBe(false)
  expect(subscription.current).toBeUndefined()
  expect(subscription.controller.signal.aborted).toBe(true)
})

test('each subscription owns its own signal, so one revocation leaves the others live', () => {
  const first = new DisplaySubscription(() => {})
  const second = new DisplaySubscription(() => {})
  expect(first.controller.signal).not.toBe(second.controller.signal)
  first.revoke()
  expect(first.live).toBe(false)
  expect(second.live).toBe(true)
  expect(second.controller.signal.aborted).toBe(false)
})

test('a listener captured before revocation still observes the aborted signal', () => {
  const seen: boolean[] = []
  const subscription = new DisplaySubscription(() => {
    seen.push(subscription.controller.signal.aborted)
  })
  const captured = subscription.current
  subscription.revoke()
  // A queued delivery re-reads `current` and finds nothing to call.
  expect(subscription.current).toBeUndefined()
  captured?.({
    type: 'display_change',
    sequence: 1,
    snapshot: Object.freeze({
      bounds: Object.freeze({ x: 0, y: 0, width: 1, height: 1 }),
      scaleFactor: 1,
    }),
    signal: subscription.controller.signal,
  })
  expect(seen).toEqual([true])
})

test('revocation aborts with the default AbortError reason', () => {
  const subscription = new DisplaySubscription(() => {})
  const reasons: unknown[] = []
  subscription.controller.signal.addEventListener('abort', () =>
    reasons.push(subscription.controller.signal.reason)
  )
  subscription.revoke()
  subscription.revoke()
  expect(reasons).toHaveLength(1)
  expect(reasons[0]).toBeInstanceOf(DOMException)
  expect((reasons[0] as DOMException).name).toBe('AbortError')
})

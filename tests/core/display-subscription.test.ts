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

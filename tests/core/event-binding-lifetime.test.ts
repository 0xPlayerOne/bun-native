import { expect, test } from 'bun:test'
import { dispatchPlan, EventBindings, type RoutedEvent } from '../../packages/core/src/events.ts'
import type { ClickEvent, NativeNode } from '@bun-native/core'

const node = Object.freeze({ kind: 'button' }) as NativeNode<'button'>
function prepare(bindings: EventBindings) {
  const event: RoutedEvent = {
    type: 'click',
    window_id: 1,
    node_id: 1,
    path: [1],
    sequence: 1,
    tree_revision: 1,
  }
  const plan = bindings.prepare(event, [node])
  if (!plan) throw new Error('Expected a real binding in the prepared dispatch')
  return plan
}

for (const reason of ['unsubscribe', 'replace', 'remove-node', 'clear'] as const)
  test(`native event ${reason} revokes the listener before abort handlers run`, async () => {
    const bindings = new EventBindings(() => {})
    let calls = 0
    const remove = bindings.register(1, node, 'click', () => {
      calls++
    })
    const plan = prepare(bindings)
    const binding = plan.deliveries[0]!.binding
    let observed: unknown
    binding.controller.signal.addEventListener(
      'abort',
      () => {
        observed = binding.invoke
        // An old unsubscribe must be harmless during its own cancellation.
        remove()
      },
      { once: true }
    )
    expect(typeof binding.invoke).toBe('function')
    if (reason === 'unsubscribe') remove()
    else if (reason === 'replace')
      bindings.register(1, node, 'click', () => {
        calls += 10
      })
    else if (reason === 'remove-node') bindings.retain(new Map())
    else bindings.clear()
    expect(binding.controller.signal.aborted).toBe(true)
    expect(observed).toBeUndefined()
    expect(binding.invoke).toBeUndefined()
    expect(binding.subscription.remove).toBeUndefined()
    remove()
    await dispatchPlan(plan, () => true)
    expect(calls).toBe(0)
    if (reason === 'replace') {
      await dispatchPlan(prepare(bindings), () => true)
      expect(calls).toBe(10)
    }
    bindings.clear()
  })

test('an abort handler can replace a replacement without reviving old callback ownership', async () => {
  const bindings = new EventBindings(() => {})
  const calls: string[] = []
  const original = bindings.register(1, node, 'click', () => {
    calls.push('original')
  })
  const oldBinding = prepare(bindings).deliveries[0]!.binding
  oldBinding.controller.signal.addEventListener(
    'abort',
    () => {
      bindings.register(1, node, 'click', () => {
        calls.push('newest')
      })
    },
    { once: true }
  )
  const replaced = bindings.register(1, node, 'click', () => {
    calls.push('superseded')
  })
  original()
  replaced()
  expect(bindings.size).toBe(1)
  expect(oldBinding.invoke).toBeUndefined()
  expect(oldBinding.subscription.remove).toBeUndefined()
  await dispatchPlan(prepare(bindings), () => true)
  expect(calls).toEqual(['newest'])
  bindings.clear()
})

test('revocation releases a pending dispatch and observes the cancelled listener rejection', async () => {
  const bindings = new EventBindings(() => {})
  const started = Promise.withResolvers<ClickEvent>()
  const listener = Promise.withResolvers<void>()
  const remove = bindings.register(1, node, 'click', (event) => {
    started.resolve(event)
    return listener.promise
  })
  const plan = prepare(bindings)
  const binding = plan.deliveries[0]!.binding
  const dispatched = dispatchPlan(plan, () => true)
  const event = await started.promise
  remove()
  await dispatched
  expect(event.signal.aborted).toBe(true)
  expect(binding.invoke).toBeUndefined()
  expect(binding.subscription.remove).toBeUndefined()
  expect(plan.deliveries).toHaveLength(0)
  listener.reject(new Error('cancelled work completed late'))
  await Promise.resolve()
})

test('native listeners keep an unbound receiver rather than receiving the internal binding', async () => {
  const bindings = new EventBindings(() => {})
  let calls = 0
  bindings.register(1, node, 'click', function (this: unknown) {
    expect(this).toBeUndefined()
    calls++
  })
  await dispatchPlan(prepare(bindings), () => true)
  expect(calls).toBe(1)
  bindings.clear()
})

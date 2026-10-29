import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { DiagnosticObserverBudget } from '../packages/runtime/src/diagnostic-observer.ts'

test('async diagnostic callbacks are bounded, reject safely and admit work after settlement', async () => {
  let errors = 0,
    calls = 0
  const budget = new DiagnosticObserverBudget(() => {
    errors++
  })
  const held = Promise.withResolvers<void>()
  const callback = () => {
    calls++
    return held.promise
  }
  for (let i = 0; i < 140; i++) budget.invoke(callback, undefined)
  assert.equal(calls, 128)
  held.reject(new Error('private failure'))
  await Promise.resolve()
  assert.equal(errors, 128)
  budget.invoke(callback, undefined)
  await Promise.resolve()
  assert.equal(calls, 129)
  assert.equal(errors, 129)
})

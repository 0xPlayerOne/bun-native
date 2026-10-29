import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { DiagnosticObserverBudget } from '../packages/runtime/src/diagnostic-observer.ts'

test('synchronous return values do not consume the asynchronous observer budget', () => {
  const budget = new DiagnosticObserverBudget()
  const values: number[] = []
  for (let i = 0; i < 140; i++) budget.invoke((value) => values.push(value), i)
  assert.equal(values.length, 140)
  assert.equal(values[139], 139)
  let calls = 0
  for (let i = 0; i < 140; i++)
    budget.invoke(() => {
      calls++
      // oxlint-disable-next-line unicorn/no-thenable -- Exercise a non-callable then property returned by an observer.
      return Object.defineProperty({}, 'then', { value: 'not a function' })
    }, undefined)
  assert.equal(calls, 140)
})

test('throwing then getters are contained without retaining observer capacity', () => {
  let errors = 0,
    calls = 0
  const budget = new DiagnosticObserverBudget(() => {
    errors++
  })
  for (let i = 0; i < 140; i++)
    budget.invoke(() => {
      calls++
      // oxlint-disable-next-line unicorn/no-thenable -- Exercise a hostile then getter without leaking observer capacity.
      return Object.defineProperty({}, 'then', {
        get() {
          throw new Error('private then getter')
        },
      })
    }, undefined)
  assert.equal(calls, 140)
  assert.equal(errors, 140)
})

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

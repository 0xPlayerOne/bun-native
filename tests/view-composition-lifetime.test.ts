import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { observeCompositionLifetime } from '../examples/view-composition/lifetime.ts'

function lifetime() {
  const closed = Promise.withResolvers<void>()
  const controller = new AbortController()
  const failures: unknown[] = []
  const observation = observeCompositionLifetime(closed.promise, controller, (error) =>
    failures.push(error)
  )
  return { closed, controller, failures, observation }
}

test('composition latches a late invalid renderer receipt and deadline during cleanup', () => {
  for (const message of ['Invalid final renderer receipt', 'Composition fixture deadline']) {
    const value = lifetime()
    value.observation.beginShutdown()
    const error = new Error(message)
    value.controller.abort(error)
    assert.deepEqual(value.failures, [error])
    value.observation.detach()
  }
})

test('composition distinguishes expected shutdown from an unexpected fulfilled close', async () => {
  const unexpected = lifetime()
  unexpected.closed.resolve()
  await Promise.resolve()
  assert.equal(unexpected.failures.length, 1)
  assert.match(String(unexpected.failures[0]), /closed before completion/)
  unexpected.observation.detach()
  const expected = lifetime()
  expected.observation.beginShutdown()
  expected.closed.resolve()
  await Promise.resolve()
  assert.deepEqual(expected.failures, [])
  expected.observation.detach()
})

test('composition never converts a failed native shutdown into expected closure', async () => {
  const value = lifetime()
  value.observation.beginShutdown()
  const error = new Error('Native shutdown failed')
  value.closed.reject(error)
  await Promise.resolve()
  assert.deepEqual(value.failures, [error])
  value.observation.detach()
})

test('composition observes an already-aborted fixture and detaches late callbacks', async () => {
  const controller = new AbortController()
  const error = new Error('Already failed')
  controller.abort(error)
  const closed = Promise.withResolvers<void>()
  const failures: unknown[] = []
  const observation = observeCompositionLifetime(closed.promise, controller, (value) =>
    failures.push(value)
  )
  assert.deepEqual(failures, [error])
  observation.detach()
  closed.reject(new Error('Late callback'))
  await Promise.resolve()
  assert.deepEqual(failures, [error])
})

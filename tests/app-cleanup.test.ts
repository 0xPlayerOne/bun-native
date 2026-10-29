import { expect, spyOn, test } from 'bun:test'
import { MockBackend, startApp } from '../packages/runtime/src/index.ts'

const config = { id: 'dev.bunly.cleanup', title: 'Cleanup', url: 'https://example.test' }

test('startup rollback attempts session cleanup and preserves both errors', async () => {
  const backend = new MockBackend()
  const closeError = new Error('window cleanup failed')
  const close = spyOn(backend, 'closeWindow').mockImplementation(async () => {
    throw closeError
  })
  const originalDispose = backend.disposeSession.bind(backend)
  let sessionAttempts = 0
  const dispose = spyOn(backend, 'disposeSession').mockImplementation(async (session) => {
    sessionAttempts++
    return originalDispose(session)
  })
  try {
    const failure = await startApp(backend, { ...config, url: 'file:///bad' }).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect((failure as AggregateError).errors[1]).toBe(closeError)
    expect(sessionAttempts).toBe(1)
    expect(backend.diagnostics()).toMatchObject({ sessions: 0, windows: 1 })
  } finally {
    close.mockRestore()
    dispose.mockRestore()
    await backend.dispose()
  }
})

test('application disposal reports window and session cleanup failures and can be retried', async () => {
  const backend = new MockBackend()
  const app = await startApp(backend, config)
  const closeError = new Error('window cleanup failed')
  const close = spyOn(backend, 'closeWindow').mockImplementation(async () => {
    throw closeError
  })
  try {
    const failure = await app.dispose().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(closeError)
    expect((failure as AggregateError).errors[1]).toMatchObject({ code: 'RESOURCE_IN_USE' })
    expect(backend.diagnostics()).toMatchObject({ sessions: 1, windows: 1, views: 1 })
  } finally {
    close.mockRestore()
    await app.dispose()
    await backend.dispose()
  }
})

test('application disposal preserves a single session cleanup error and retries it', async () => {
  const backend = new MockBackend()
  const app = await startApp(backend, config)
  const sessionError = new Error('session cleanup failed')
  const dispose = spyOn(backend, 'disposeSession').mockImplementation(async () => {
    throw sessionError
  })
  try {
    expect(await app.dispose().catch((error: unknown) => error)).toBe(sessionError)
    expect(backend.diagnostics()).toMatchObject({ sessions: 1, windows: 0, views: 0 })
  } finally {
    dispose.mockRestore()
    await app.dispose()
    await backend.dispose()
  }
})

test('startup rollback retains all failures when both cleanups fail', async () => {
  const backend = new MockBackend()
  const closeError = new Error('window cleanup failed')
  const sessionError = new Error('session cleanup failed')
  const close = spyOn(backend, 'closeWindow').mockImplementation(async () => {
    throw closeError
  })
  const dispose = spyOn(backend, 'disposeSession').mockImplementation(async () => {
    throw sessionError
  })
  try {
    const failure = await startApp(backend, { ...config, url: 'file:///bad' }).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(3)
    expect((failure as AggregateError).errors[0]).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect((failure as AggregateError).errors.slice(1)).toEqual([closeError, sessionError])
  } finally {
    close.mockRestore()
    dispose.mockRestore()
    await backend.dispose()
  }
})

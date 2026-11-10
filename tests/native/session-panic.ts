// A real Rust panic in the host after the session is established (#247). The
// caller launches Bun with BUN_NATIVE_TEST_FAULT=panic-in-batch, which the host
// reads at startup: the window opens normally, then the first batch panics
// inside its GPUI window update. Every pending request, the window and the
// application must reject with one typed `panic` diagnostic in the
// `running` phase whose location is the injected panic in session.rs.
import { createApplication, NativeHostExitError, type NativeApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'

const executable = process.env['BUN_NATIVE_HOST']
if (
  !executable ||
  !isAbsolute(executable) ||
  process.env['BUN_NATIVE_TEST_FAULT'] !== 'panic-in-batch'
)
  throw new Error(
    'An absolute BUN_NATIVE_HOST and BUN_NATIVE_TEST_FAULT=panic-in-batch are required'
  )

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the injected native panic, but the operation resolved')
}

let app: NativeApplication | undefined
try {
  app = await createApplication({ executable, requestTimeoutMs: 10_000 })
  const window = await app.openWindow({
    title: 'Bun Native session panic',
    width: 480,
    height: 320,
  })
  const started = performance.now()
  const batch = rejection(
    window.batch((batch) =>
      batch.append(window.root, batch.create({ kind: 'text', text: 'Never applied' }))
    )
  )
  const failure = await rejection(app.closed)
  const elapsedMs = Math.round(performance.now() - started)
  assert(
    failure instanceof NativeHostExitError,
    `Expected NativeHostExitError, got ${String(failure)}`
  )
  assert.equal(await batch, failure, 'The pending batch rejects with the same diagnostic')
  await window.closed
  assert.equal(await rejection(app.shutdown()), failure)
  const { diagnostic } = failure
  console.log(
    JSON.stringify({
      elapsedMs,
      reason: diagnostic.reason,
      exitCode: diagnostic.exitCode,
      signal: diagnostic.signal,
      phase: diagnostic.phase,
      pendingRequests: diagnostic.pendingRequests,
      panicLocation: diagnostic.panicLocation,
      panicMessage: diagnostic.stderrTail.includes('Bun Native test fault: injected panic'),
      ownership: app.diagnostics,
    })
  )
} finally {
  await app?.shutdown().catch(() => {})
}

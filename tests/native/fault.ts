import { createApplication, ProtocolError, type NativeApplication } from '@bun-native/core'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const executable = process.env['BUN_NATIVE_HOST']
const scenario = process.env['BUN_NATIVE_DIAGNOSTICS_SCENARIO']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (
  !directory ||
  !executable ||
  !nonce ||
  !['startup-failure', 'host-crash'].includes(scenario ?? '')
)
  throw new Error('Explicit native diagnostics directory, host and scenario are required')
const started = performance.now()
function record(type: string, fields: Record<string, unknown> = {}): void {
  appendFileSync(
    join(directory!, 'application.jsonl'),
    JSON.stringify({ nonce, type, atMs: performance.now() - started, ...fields }) + '\n'
  )
}
async function waitFor(name: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!existsSync(join(directory!, name))) {
    if (performance.now() >= deadline) throw new Error(`Controller deadline: ${name}`)
    await Bun.sleep(5)
  }
}
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof Error)
    return error
  }
  throw new Error('Expected real native failure, but operation resolved')
}
function requireTransportExit(error: Error): void {
  assert(
    (error instanceof ProtocolError && error.message === 'Native output closed before shutdown') ||
      (error.name === 'Error' &&
        /^Native host exited unexpectedly \(-?\d+\)\./.test(error.message)),
    `Expected transport EOF/process exit after the real native fault, got ${error.name}: ${error.message}`
  )
}
function zeroOwnership(app: NativeApplication): void {
  assert.deepEqual(app.diagnostics, {
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
    serviceRequests: 0,
  })
}
let app: NativeApplication | undefined
try {
  if (scenario === 'startup-failure') {
    assert.equal(process.env['DISPLAY'], 'bun-native-invalid-display')
    const error = await rejection(createApplication({ executable, requestTimeoutMs: 2_000 }))
    requireTransportExit(error)
    assert(performance.now() - started < 2_000, 'Native startup failure must arrive before timeout')
    record('startup-rejected', { errorName: error.name, errorMessage: error.message })
  } else {
    app = await createApplication({ executable, requestTimeoutMs: 3_000 })
    const window = await app.openWindow({
      title: 'Bun Native native fault',
      width: 560,
      height: 380,
    })
    const { label, button } = await window.batch((batch) => {
      batch.set(window.root, {
        kind: 'box',
        style: { direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 },
      })
      const heading = batch.create({
        kind: 'text',
        text: 'Native fault audit',
        style: { font_size: 28 },
      })
      const label = batch.create({ kind: 'text', text: 'Waiting for actual click' })
      const button = batch.create({
        kind: 'button',
        text: 'Begin fault test',
        style: { width: 200, height: 44 },
      })
      for (const node of [heading, label, button]) batch.append(window.root, node)
      return { label, button }
    })
    let callbackSignal: AbortSignal | undefined
    window.onClick(button, (event) => {
      assert.equal(callbackSignal, undefined, 'Fault injection requires one actual click')
      callbackSignal = event.signal
      record('callback-waiting', { sequence: event.sequence })
      return new Promise<void>(() => {})
    })
    record('mounted')
    await waitFor('queue-after-stop')
    assert(callbackSignal && !callbackSignal.aborted)
    assert.equal(app.diagnostics.activeCallbacks, 1)
    const pending = [
      rejection(
        window.batch((batch) =>
          batch.set(label, { kind: 'text', text: 'Must never be acknowledged' })
        )
      ),
      rejection(
        window.batch((batch) =>
          batch.set(label, { kind: 'text', text: 'Queued operation must reject' })
        )
      ),
    ]
    record('pending', { ownership: app.diagnostics })
    const failure = await rejection(app.closed)
    requireTransportExit(failure)
    const pendingErrors = await Promise.all(pending)
    for (const error of pendingErrors) {
      requireTransportExit(error)
      assert.equal(error, failure)
    }
    await window.closed
    assert.equal(callbackSignal.aborted, true)
    zeroOwnership(app)
    const stopped = await rejection(app.shutdown())
    assert.equal(stopped, failure)
    record('crash-contained', {
      errorName: failure.name,
      errorMessage: failure.message,
      pendingRejected: pendingErrors.length,
      callbackAborted: callbackSignal.aborted,
      ownership: app.diagnostics,
    })
  }
  writeFileSync(
    join(directory, 'application-result.json'),
    JSON.stringify({ status: 'passed', scenario, elapsedMs: performance.now() - started }) + '\n'
  )
} finally {
  await app?.shutdown().catch(() => {})
}

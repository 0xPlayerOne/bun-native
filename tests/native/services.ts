/** Actual GPUI service fixture. An independent driver clicks, observes paint, and OS-closes it. */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type NativeApplication,
} from '@bun-native/core'
import { NativeCommandError, NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { mountContent, recordEvidence } from '../../examples/native-window/content.ts'

const configuredHost = process.env['BUN_NATIVE_HOST']
if (!configuredHost) throw new Error('Set BUN_NATIVE_HOST to the explicit prebuilt native host')
const executable = resolve(configuredHost)
const permissions = { windowDisplay: 'allow' } as const
const outcomes = {
  deniedByNativePolicy: false,
  queuedCancellation: false,
  nativeStaleOwner: false,
  nativeUnknownOwner: false,
  shutdownBeforeDispatch: false,
  publicStaleHandle: false,
}

async function stopped(app: NativeApplication) {
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((count) => count === 0))
}

const denied = await createApplication({ executable })
try {
  const window = await denied.openWindow({ title: 'Bun Native denied service' })
  await assert.rejects(
    window.displaySnapshot(),
    (error: unknown) => error instanceof NativeServiceError && error.code === 'permission_denied'
  )
  outcomes.deniedByNativePolicy = true
} finally {
  await stopped(denied)
}

const raw = await NativeHost.launch({ executable, permissions })
try {
  await raw.send({
    type: 'open',
    window_id: 1,
    root_id: 1,
    title: 'Bun Native native service ownership',
    width: 560,
    height: 380,
  })
  const snapshot = await raw.send({ type: 'display_snapshot', window_id: 1 })
  assert(snapshot.snapshot.bounds.width > 0)
  await raw.send({ type: 'close', window_id: 1 })
  await assert.rejects(
    raw.send({ type: 'display_snapshot', window_id: 1 }),
    (error: unknown) => error instanceof NativeCommandError && error.code === 'invalid_handle'
  )
  outcomes.nativeStaleOwner = true
  await assert.rejects(
    raw.send({ type: 'display_snapshot', window_id: 2 }),
    (error: unknown) => error instanceof NativeCommandError && error.code === 'invalid_handle'
  )
  outcomes.nativeUnknownOwner = true
} finally {
  await raw.shutdown()
  assert.equal(await raw.exited, 0)
}

const closing = await createApplication({ executable, permissions })
try {
  const window = await closing.openWindow({ title: 'Bun Native service shutdown' })
  const pending = window.displaySnapshot()
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_state'
  )
  const shutdown = closing.shutdown()
  await rejected
  await shutdown
  outcomes.shutdownBeforeDispatch = true
} finally {
  await stopped(closing)
}

const app = await createApplication({ executable, permissions })
let failure: Error | undefined
let activations = 0
let deadline: ReturnType<typeof setTimeout> | undefined
try {
  assert.equal(app.serviceCapabilities.windowDisplay.permission, 'allow')
  assert.equal(app.serviceCapabilities.clipboardText.availability, 'unavailable')
  const window = await app.openWindow({
    title: 'Bun Native desktop services',
    width: 560,
    height: 380,
  })
  const { label, button } = await mountContent(window)
  const cancellation = new AbortController()
  const cancelled = window.displaySnapshot({ signal: cancellation.signal })
  cancellation.abort()
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof NativeServiceError && error.code === 'cancelled'
  )
  outcomes.queuedCancellation = true
  window.onClick(button, async (event) => {
    activations++
    assert.equal(activations, 1)
    assert(event.sequence > 0)
    const snapshot = await window.displaySnapshot({ signal: event.signal })
    recordEvidence({
      type: 'click',
      target: 'window-display',
      sequence: event.sequence,
      snapshot,
      outcomes: { ...outcomes },
    })
    await window.batch((batch) =>
      batch.set(label, {
        kind: 'text',
        text: `Display: ${snapshot.bounds.width}x${snapshot.bounds.height} @${snapshot.scaleFactor}`,
      })
    )
  })
  // Publish the ready paint only after cancellation checks and listener setup;
  // the input driver cannot mistake an earlier mount for a callable fixture.
  await window.batch((batch) => {
    batch.set(label, { kind: 'text', text: 'Display ready' })
    batch.set(button, { kind: 'button', text: 'Read display', style: { width: 160, height: 44 } })
  })
  await Promise.race([
    window.closed,
    new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error('Native service fixture deadline expired')),
        45_000
      )
    }),
  ])
  await assert.rejects(
    window.displaySnapshot(),
    (error: unknown) => error instanceof NativeStateError && error.code === 'invalid_handle'
  )
  outcomes.publicStaleHandle = true
  assert.equal(activations, 1)
} catch (cause) {
  failure = cause instanceof Error ? cause : new Error(String(cause))
} finally {
  clearTimeout(deadline)
  try {
    await stopped(app)
  } catch (cause) {
    failure ??= cause instanceof Error ? cause : new Error(String(cause))
  }
  if (!Object.values(outcomes).every(Boolean))
    failure ??= new Error('A required native service outcome is missing')
  const path = process.env['BUN_NATIVE_EVIDENCE_LOG']
  if (path)
    writeFileSync(
      join(dirname(path), 'services-result.json'),
      JSON.stringify(
        {
          status: failure ? 'failed' : 'passed',
          outcomes,
          activations,
          ownership: app.diagnostics,
          error: failure?.message,
        },
        null,
        2
      ) + '\n'
    )
}
if (failure) throw failure

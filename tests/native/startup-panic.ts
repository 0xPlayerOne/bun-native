// A real GPUI panic in the release host, without a test-only fault command:
// with an unreachable X display (and no Wayland), GPUI's Linux platform panics
// while connecting, before the protocol channel is served. The Bun launch must
// reject with a typed, redacted `panic` diagnostic in the `starting` phase.
// The caller sets DISPLAY to a unique unreachable value, which is inherited
// environment and so must never appear in the diagnostic.
import { NativeHost, NativeHostExitError } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'

const executable = process.env['BUN_NATIVE_HOST']
const display = process.env['DISPLAY']
if (!executable || !isAbsolute(executable) || !display || process.env['WAYLAND_DISPLAY'])
  throw new Error(
    'An absolute BUN_NATIVE_HOST and an unreachable DISPLAY without Wayland are required'
  )

const started = performance.now()
let failure: unknown
try {
  const host = await NativeHost.launch({ executable, requestTimeoutMs: 5_000 })
  await host.shutdown()
} catch (error) {
  failure = error
}
const elapsedMs = Math.round(performance.now() - started)
assert(
  failure instanceof NativeHostExitError,
  `Expected NativeHostExitError, got ${String(failure)}`
)
const { diagnostic } = failure
assert(!diagnostic.stderrTail.includes(display), 'The inherited DISPLAY value leaked')
assert(!failure.message.includes(display), 'The inherited DISPLAY value leaked into the message')
console.log(
  JSON.stringify({
    elapsedMs,
    reason: diagnostic.reason,
    exitCode: diagnostic.exitCode,
    signal: diagnostic.signal,
    phase: diagnostic.phase,
    pendingRequests: diagnostic.pendingRequests,
    panicLocation: diagnostic.panicLocation,
    panicReport: diagnostic.stderrTail.includes('panicked at'),
    redacted: diagnostic.stderrTail.includes('[redacted]'),
  })
)

import assert from 'node:assert/strict'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function admitted(value: unknown) {
  const diagnostic = record(value)
  const admission = record(diagnostic['commandAdmission'])
  for (const [field, limit] of [
    ['requests', 256],
    ['ordinaryRequests', 192],
    ['retainedWireBytes', 2 * 1024 * 1024],
    ['ordinaryWireBytes', 1536 * 1024],
    ['peakRequests', 256],
    ['peakWireBytes', 2 * 1024 * 1024],
  ] as const) {
    const count = admission[field]
    assert.ok(
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= limit
    )
  }
  return { diagnostic, admission }
}
/** Actual native disposal behind a saturated application request pool. No CEF
 * pause/debug hook: synchronous submission establishes pressure before replies
 * can be consumed by Bun's event loop. Wire order must remain unchanged. */
export async function qualifyControlAdmission(backend: CefBackend) {
  const session = await backend.createSession({
    partition: 'control-capacity',
    persistence: 'ephemeral',
  })
  assert.equal(backend.nativeTransportDiagnostics().controlAdmissionsUnderPressure, 0)
  const replies = Promise.all(Array.from({ length: 96 }, () => backend.nativeDiagnostics()))
  const overflow = assert.rejects(backend.nativeDiagnostics(), /ordinary request capacity/)
  assert.equal(backend.nativeTransportDiagnostics().ordinaryRequests, 96)
  const dispose = backend.disposeSession(session)
  // Subscribe to every result before yielding. A failed scenario never leaves
  // its other native promises unobserved or manufactures an acknowledgment.
  const [snapshots] = await Promise.all([replies, overflow, dispose])
  assert.equal(backend.nativeTransportDiagnostics().controlAdmissionsUnderPressure, 1)
  for (const snapshot of snapshots) {
    const { diagnostic } = admitted(snapshot)
    assert.equal(diagnostic['sessions'], 1, 'Control must not overtake prior commands')
  }
  const { diagnostic, admission } = admitted(await backend.nativeDiagnostics())
  assert.equal(diagnostic['sessions'], 0)
  assert.equal(diagnostic['pending'], 0)
  assert.equal(admission['requests'], 1, 'Only this diagnostics command may remain owned')
  assert.equal(admission['ordinaryRequests'], 1)
  assert.equal(backend.diagnostics().sessions, 0)
  return Object.freeze({
    ordinaryRequests: 96,
    ordinaryOverflowDenied: true,
    control: 'session.dispose',
    controlCompleted: true,
    controlAdmittedWhileFull: true,
    fifoPreserved: true,
    nativeBudgetBounded: true,
    finalSessions: 0,
    priorTaskReservationsReleased: true,
  })
}

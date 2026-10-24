import assert from 'node:assert/strict'
import { nativeEvents, acceptNativeSmoke } from './cef-acceptance.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
import { validateCommandObservation, type CommandObservation } from './observed-command.ts'

export const nativeRpcCases = Object.freeze(
  [
    'duplicate-ready',
    'duplicate-subscription',
    'invalid-number',
    'stale-ack',
    'stale-generation',
    'stale-grant',
    'stale-result',
    'stale-revoke',
    'wrong-connection',
    'wrong-context',
    'wrong-frame',
  ].sort()
)

/** Validate retained native observations; a generic/older smoke flag is insufficient. */
export function acceptNativeRpc(report: CommandObservation, requireMacCleanup = false): void {
  acceptNativeSmoke(report)
  requireNativeShutdown(observeNativeShutdown(report))
  if (requireMacCleanup)
    assert.equal(
      report.postExitCleanup?.qualified,
      true,
      'Native RPC helper/clone cleanup was not qualified'
    )
  const records = nativeEvents(report).filter((event) => event['event'] === 'bunly.native.rpc')
  assert.equal(records.length, 1, 'Native RPC evidence missing or duplicated')
  assert.deepEqual(
    records[0],
    {
      event: 'bunly.native.rpc',
      schema: 6,
      controlAdmission: {
        ordinaryRequests: 96,
        ordinaryOverflowDenied: true,
        control: 'session.dispose',
        controlCompleted: true,
        controlAdmittedWhileFull: true,
        fifoPreserved: true,
        nativeBudgetBounded: true,
        outputBudget: 'bounded-native-fifo-wire-reservations',
        finalSessions: 0,
        priorTaskReservationsReleased: true,
      },
      sessionAuthority: 'native-owner-isolation-and-partition-reuse',
      viewDisposal: 'isolated-and-parent-close',
      renderer: {
        schema: 2,
        json: 'bun:renderer',
        binary: [0, 1, 2, 127, 128, 255],
        cancellation: 'backend-started-and-aborted',
        validation: 'backend-rejected-invalid-input',
      },
      hostileExternalScript: true,
      lifecycleCycles: 2,
      navigationPending: true,
      closePending: true,
      returnUnprivileged: true,
      remoteUnprivileged: true,
      staleDelivered: false,
      resourcesBounded: true,
      protocolCases: nativeRpcCases,
    },
    'Native RPC workload evidence does not match the required cases'
  )
}

export const nativeRpcLaunchNames = Object.freeze([
  'installed-0',
  'installed-1',
  'installed-2',
  'last-window',
  'restored-installation',
] as const)

/** All RPC/lifecycle cases must pass, including every cleanup failure check.
 * A sampling gap is not a proven helper failure or a qualified helper sample.
 * Keep coverage separate, require actual verified cleanup within the same fixed
 * macOS suite, and never retry an absent sample into an invented per-launch pass.
 */
export function acceptNativeRpcSuite(
  trials: readonly { readonly name?: unknown; readonly observation?: unknown }[],
  requireMacCleanup = false
) {
  assert.equal(trials.length, nativeRpcLaunchNames.length, 'Native RPC launch matrix is incomplete')
  const names = new Set<string>()
  const qualifiedLaunches: string[] = []
  const unobservedLaunches: string[] = []
  for (const trial of trials) {
    assert.ok(
      typeof trial.name === 'string' && nativeRpcLaunchNames.some((name) => name === trial.name)
    )
    assert.ok(!names.has(trial.name), 'Duplicate native RPC launch')
    names.add(trial.name)
    const observation = validateCommandObservation(trial.observation)
    // A qualified observation in another launch cannot erase this one's failure.
    acceptNativeRpc(observation)
    if (requireMacCleanup) {
      const cleanup = observation.postExitCleanup
      assert.ok(cleanup, 'Native RPC helper accounting is unavailable')
      if (cleanup.qualified) qualifiedLaunches.push(trial.name)
      else {
        assert.equal(cleanup.status, 'not-observed')
        assert.equal(cleanup.passed, true)
        unobservedLaunches.push(trial.name)
      }
    }
  }
  if (requireMacCleanup)
    assert.ok(
      qualifiedLaunches.length > 0,
      'Native RPC suite has no verified helper/clone completion'
    )
  return Object.freeze({
    acceptedLaunches: trials.length,
    helperCleanup: Object.freeze({
      scope: requireMacCleanup ? 'same-suite-sampled-coverage' : 'not-applicable',
      qualifiedLaunches: Object.freeze(qualifiedLaunches),
      unobservedLaunches: Object.freeze(unobservedLaunches),
    }),
  })
}

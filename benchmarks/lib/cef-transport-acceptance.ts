import assert from 'node:assert/strict'
import { nativeEvents } from './cef-acceptance.ts'
import { assertCleanCommand, type CommandObservation } from './observed-command.ts'
import { requireNativeShutdown, observeNativeShutdown } from '../foundation/native-shutdown.ts'
import {
  RPC_TRANSPORT_WORKLOAD,
  type RpcTransportCandidate,
  type RpcTransportTrial,
} from '../rpc-transport-comparison.ts'

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort())
}
function duration(value: unknown): number {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 30000)
  return value
}
function bounded(value: unknown, maximum: number): number {
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
  )
  return value
}

export function acceptNativeTransport(
  report: CommandObservation,
  candidate: RpcTransportCandidate,
  index: number
): RpcTransportTrial & { readonly throttledMs: number; readonly fragmentPeak: number } {
  assertCleanCommand(report)
  requireNativeShutdown(observeNativeShutdown(report))
  assert.ok(candidate === 'native-mediated' || candidate === 'authenticated-loopback')
  assert.ok(Number.isSafeInteger(index) && index >= -10 && index <= 100)
  const events = nativeEvents(report)
  assert.deepEqual(
    events.filter((event) => event['event'] === 'bunly.native.transport-throttle'),
    [
      { event: 'bunly.native.transport-throttle', rate: 4, completed: true },
      { event: 'bunly.native.transport-throttle', rate: 1, completed: true },
    ]
  )
  const records = events.filter((event) => event['event'] === 'bunly.native.transport')
  assert.equal(records.length, 1, 'Native transport evidence is missing or duplicated')
  const record = records[0]!
  keys(record, [
    'event',
    'schema',
    'passed',
    'candidate',
    'workload',
    'metrics',
    'queuePeaks',
    'validation',
    'nativeConfirmation',
    'fragmentBudget',
    'idleProfile',
  ])
  assert.equal(record['schema'], 1)
  assert.equal(record['passed'], true)
  assert.equal(record['candidate'], candidate)
  assert.deepEqual(record['workload'], RPC_TRANSPORT_WORKLOAD)
  assert.equal(record['idleProfile'], 'two-seconds-with-one-admitted-control-waiter-no-polling')
  assert.deepEqual(record['validation'], {
    structured: 100,
    binaryCalls: 50,
    binaryBytes: 65536,
    cancellations: 20,
    throttledCalls: 20,
    nativeThrottleRate: 4,
    throttleRestored: true,
    navigationRevocation: true,
    returnDenied: true,
    serviceDisconnect: true,
    serverClose: true,
    resourcesReleased: true,
    crossViewCredentialDenied:
      candidate === 'authenticated-loopback'
        ? 'native-confirmation-rejected'
        : 'no-loopback-listener',
  })
  assert.deepEqual(record['nativeConfirmation'], {
    accepted: candidate === 'authenticated-loopback' ? 2 : 0,
    rejected: candidate === 'authenticated-loopback' ? 1 : 0,
  })
  const metrics = object(record['metrics'])
  keys(metrics, ['handoffMs', 'structuredMs', 'binaryMs', 'cancellationMs', 'throttledMs'])
  const peaks = object(record['queuePeaks'])
  keys(peaks, ['clientFrames', 'clientBytes', 'serverFrames', 'serverBytes'])
  const fragment = object(record['fragmentBudget'])
  keys(fragment, ['retainedBytes', 'peakRetainedBytes', 'maxRetainedBytes'])
  assert.equal(fragment['retainedBytes'], 0)
  assert.equal(fragment['maxRetainedBytes'], 3 * 1024 * 1024)
  return {
    candidate,
    trial: index,
    handoffMs: duration(metrics['handoffMs']),
    structuredMs: duration(metrics['structuredMs']),
    binaryMs: duration(metrics['binaryMs']),
    cancellationMs: duration(metrics['cancellationMs']),
    throttledMs: duration(metrics['throttledMs']),
    queuePeaks: {
      clientFrames: bounded(peaks['clientFrames'], 128),
      clientBytes: bounded(peaks['clientBytes'], 2 * 1024 * 1024),
      serverFrames: bounded(peaks['serverFrames'], 128),
      serverBytes: bounded(peaks['serverBytes'], 2 * 1024 * 1024),
    },
    fragmentPeak: bounded(fragment['peakRetainedBytes'], 3 * 1024 * 1024),
  }
}

export function idleKernelObservation(value: unknown) {
  if (value === undefined)
    return {
      status: 'unavailable' as const,
      metrics: [],
      reason: 'Kernel provider was not collected',
    }
  const report = object(value)
  assert.ok(['observed', 'unavailable'].includes(String(report['status'])))
  assert.ok(Array.isArray(report['metrics']) && report['metrics'].length <= 64)
  const metrics = report['metrics']
    .filter((entry: unknown) => object(entry)['phase'] === 'transport-idle')
    .map((entry: unknown) => {
      const metric = object(entry)
      assert.ok(typeof metric['provider'] === 'string' && metric['provider'].length <= 128)
      assert.ok(typeof metric['metric'] === 'string' && metric['metric'].length <= 128)
      const delta = bounded(metric['observedDelta'], Number.MAX_SAFE_INTEGER),
        milliseconds = duration(metric['sampledDurationMs'])
      assert.ok(milliseconds > 0)
      return {
        provider: metric['provider'],
        metric: metric['metric'],
        observedDelta: delta,
        sampledDurationMs: milliseconds,
        matchedScopeIntervals: bounded(metric['matchedScopeIntervals'], 10000000),
        observedPerSecond: (delta * 1000) / milliseconds,
      }
    })
  return {
    status: metrics.length ? ('observed' as const) : ('unavailable' as const),
    metrics,
    reason: metrics.length
      ? 'Adjacent matched process/task identities; sampled lower bound, not lifetime accounting'
      : String(
          Array.isArray(report['limitations'])
            ? report['limitations'].join('; ')
            : 'No matched idle samples'
        ),
  }
}

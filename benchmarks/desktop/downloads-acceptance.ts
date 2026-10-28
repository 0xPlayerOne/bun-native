import assert from 'node:assert/strict'
import {
  DOWNLOAD_WORKLOAD_MS,
  downloadFixturePayloads,
  downloadFixtureSteps,
} from '../../examples/file-downloads/contract.ts'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { validateCommandObservation } from '../lib/observed-command.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const DOWNLOADS_PROFILE = 'native-file-downloads-v1'
// Keep every historical desktop profile's selectors unchanged for offline replay.
export const downloadsSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/file-downloads',
] as const
const requiredSources = [
  'packages/contracts/src/downloads.ts',
  'packages/runtime/src/cef-downloads.ts',
  'packages/runtime/src/native-capacity.json',
  'native/cef-host/Cargo.toml',
  'native/cef-host/Cargo.lock',
  'native/cef-host/src/capability_policy.rs',
  'native/cef-host/src/command_budget.rs',
  'native/cef-host/src/download_access.rs',
  'native/cef-host/src/download_deadline.rs',
  'native/cef-host/src/download_files.rs',
  'native/cef-host/src/download_files_unix.rs',
  'native/cef-host/src/download_files_windows.rs',
  'native/cef-host/src/downloads.rs',
  'native/cef-host/src/file_guards.rs',
  'native/cef-host/src/lib.rs',
  'native/cef-host/src/scheme.rs',
  'examples/file-downloads/fixture.ts',
  'examples/file-downloads/client.ts',
  'examples/file-downloads/contract.ts',
  'examples/file-downloads/readiness.ts',
  'examples/file-downloads/server.ts',
  'examples/file-downloads/public/index.html',
  'benchmarks/desktop/downloads-acceptance.ts',
  'benchmarks/desktop/profiles.ts',
  'benchmarks/lib/native-diagnostic-events.json',
  'scripts/hosted_cef.py',
  'scripts/qualify-cef-window-modes-linux.py',
] as const

function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Expected record')
  return input as Record<string, unknown>
}
function keys(input: Record<string, unknown>, expected: readonly string[]) {
  assert.deepEqual(Object.keys(input).sort(), [...expected].sort())
}
function integer(input: unknown, minimum: number, maximum: number) {
  assert.ok(Number.isSafeInteger(input) && Number(input) >= minimum && Number(input) <= maximum)
}
function shutdownReceipt(input: unknown) {
  assert.deepEqual(input, {
    schema: 1,
    passed: true,
    admitted: 14,
    terminalCallbacks: 14,
    completed: 3,
    cancelled: 7,
    failed: 4,
    ownedTransfers: 0,
    ownedCallbacks: 0,
    ownedStagingHandles: 0,
    ownedDeadlineWorkers: 0,
  })
}

export function acceptFileDownloadsReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 16 * 1024)
  keys(receipt, [
    'event',
    'schema',
    'passed',
    'workloadMs',
    'observations',
    'nativeBeforeQuit',
    'failure',
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
  assert.equal(receipt['event'], 'bunly.native.file-downloads')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.ok(
    typeof receipt['workloadMs'] === 'number' &&
      Number.isFinite(receipt['workloadMs']) &&
      receipt['workloadMs'] > 0 &&
      receipt['workloadMs'] <= DOWNLOAD_WORKLOAD_MS
  )
  for (const flag of [
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[flag], false)
  const observations = record(receipt['observations'])
  keys(observations, [
    'steps',
    'checks',
    'documents',
    'settledBaseline',
    'network',
    'downloadShutdown',
    'shutdownSucceeded',
    'temporaryCleanup',
    'final',
  ])
  assert.deepEqual(observations['checks'], {
    permissionDenied: true,
    traversalRejected: true,
    rootMismatchRejected: true,
    duplicatePreserved: true,
    nonfileDestinationRejected: true,
    redirectNeverReachedBlockedOrigin: true,
    staleGrantRejected: true,
    cancelDuringQuitRequested: true,
    sentinelPreserved: true,
  })
  const documents = observations['documents']
  assert.ok(Array.isArray(documents) && documents.length === 5 && new Set(documents).size === 5)
  for (const document of documents)
    assert.ok(typeof document === 'string' && /^[a-z0-9-]{1,128}$/.test(document))
  const steps = observations['steps']
  assert.ok(Array.isArray(steps))
  assert.deepEqual(
    steps.map((step: unknown) => record(step)['name']),
    downloadFixtureSteps
  )
  const failures: Readonly<Record<string, string>> = {
    'denied-redirect': 'permission',
    'unknown-size-limit': 'limit',
    'transfer-timeout': 'timeout',
    'network-interruption': 'network',
  }
  for (const [index, input] of steps.entries()) {
    const step = record(input)
    keys(step, ['name', 'outcome', 'notifications', 'positiveProgress', 'sha256'])
    integer(step['notifications'], 1, 256)
    assert.equal(typeof step['positiveProgress'], 'boolean')
    const name = String(step['name'])
    const outcome = record(step['outcome'])
    integer(outcome['bytesReceived'], 0, downloadFixturePayloads.large.bytes)
    if (index < 3) {
      const payload = index === 1 ? downloadFixturePayloads.large : downloadFixturePayloads.small
      assert.deepEqual(outcome, {
        status: 'completed',
        bytesReceived: payload.bytes,
        bytesWritten: payload.bytes,
      })
      assert.equal(step['sha256'], payload.sha256)
    } else {
      const failure = failures[name]
      keys(
        outcome,
        failure === undefined
          ? ['status', 'bytesReceived', 'bytesWritten']
          : ['status', 'bytesReceived', 'bytesWritten', 'failure']
      )
      assert.equal(outcome['status'], failure === undefined ? 'cancelled' : 'failed')
      if (failure !== undefined) assert.equal(outcome['failure'], failure)
      assert.equal(outcome['bytesWritten'], 0)
      assert.equal(step['sha256'], null)
      if (failure === undefined) {
        assert.equal(
          step['positiveProgress'],
          true,
          'Cancellation must follow observed native bytes'
        )
        assert.ok(Number(outcome['bytesReceived']) > 0)
      }
      if (name === 'denied-redirect') assert.equal(outcome['bytesReceived'], 0)
      if (name === 'unknown-size-limit') assert.ok(Number(outcome['bytesReceived']) > 64 * 1024)
    }
  }
  const network = record(observations['network'])
  keys(network, ['requestCount', 'blockedRequests', 'activeStreams', 'cancelledStreams'])
  integer(network['requestCount'], 15, 256)
  assert.equal(network['blockedRequests'], 0)
  assert.equal(network['activeStreams'], 0)
  // Seven positively observed cancellations and the unknown-size transfer must
  // close their streams. A timeout may expire before its HTTP request starts.
  integer(network['cancelledStreams'], 8, 9)
  const zero = {
    views: 0,
    sessions: 0,
    windows: 1,
    rpcBindings: 0,
    pending: 0,
    downloads: 0,
    nativeDeliveryPackets: 0,
    nativeDeliveryBytes: 0,
    rpcIncomingBytes: 0,
    streamIncomingBytes: 0,
  }
  assert.deepEqual(observations['settledBaseline'], zero)
  assert.deepEqual(receipt['nativeBeforeQuit'], { ...zero, views: 1, sessions: 1, downloads: 1 })
  shutdownReceipt(observations['downloadShutdown'])
  assert.equal(observations['shutdownSucceeded'], true)
  assert.equal(observations['temporaryCleanup'], true)
  assert.deepEqual(observations['final'], {
    windows: 0,
    views: 0,
    sessions: 0,
    listeners: 0,
    listenerErrors: 0,
  })
  return Object.freeze({
    transfers: 14,
    completed: 3,
    cancelled: 7,
    failed: 4,
    documents: 5,
    nativeOwnershipReleased: true,
    temporaryCleanup: true,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  })
}

export function acceptFileDownloads(input: unknown) {
  const result = acceptDesktopObservation(
    input,
    'bunly.native.file-downloads',
    acceptFileDownloadsReceipt
  )
  const events = nativeEvents(validateCommandObservation(input))
  const shutdown = events.filter((event) => event['event'] === 'bunly.host.download-shutdown')
  assert.equal(shutdown.length, 1, 'Missing or duplicate native download settlement receipt')
  const { event: name, ...counts } = shutdown[0]!
  assert.equal(name, 'bunly.host.download-shutdown')
  shutdownReceipt(counts)
  const receipt = events.find((event) => event['event'] === 'bunly.native.file-downloads')!
  assert.deepEqual(record(receipt['observations'])['downloadShutdown'], counts)
  const processStop = events.findIndex(
    (event) =>
      event['event'] === 'bunly.host.shutdown-phase' &&
      event['phase'] === 'process-stop' &&
      event['state'] === 'start'
  )
  const backendExit = events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  assert.ok(
    events.indexOf(shutdown[0]!) < processStop,
    'Native transfer settlement must precede ordinary shutdown'
  )
  assert.ok(
    processStop < events.indexOf(receipt) && events.indexOf(receipt) < backendExit,
    'Application receipt must follow the private shutdown response and precede backend exit'
  )
  return result
}

export function acceptDownloadsReport(input: unknown) {
  return acceptDesktopEvidence(input, DOWNLOADS_PROFILE, requiredSources, acceptFileDownloads)
}

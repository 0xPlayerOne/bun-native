import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import {
  DOWNLOADS_PROFILE,
  acceptFileDownloadsReceipt,
  acceptFileDownloads,
  acceptDownloadsReport,
} from '../benchmarks/desktop/downloads-acceptance.ts'
import { desktopProfile, desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import {
  DOWNLOAD_WORKLOAD_MS,
  downloadFixturePayloads,
  downloadFixtureSteps,
} from '../examples/file-downloads/contract.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

// Synthetic rejection/parser inputs only; these are never native execution evidence.
function receipt() {
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
  const failures: Readonly<Record<string, string>> = {
    'denied-redirect': 'permission',
    'unknown-size-limit': 'limit',
    'transfer-timeout': 'timeout',
    'network-interruption': 'network',
  }
  return {
    event: 'bunly.native.file-downloads',
    schema: 1,
    passed: true,
    failure: null,
    workloadMs: 5000,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
    observations: {
      steps: downloadFixtureSteps.map((name, index) => {
        const payload = index === 1 ? downloadFixturePayloads.large : downloadFixturePayloads.small
        const failure = failures[name]
        return {
          name: String(name),
          notifications: 3,
          positiveProgress: name !== 'denied-redirect',
          sha256: index < 3 ? String(payload.sha256) : null,
          outcome: {
            status: index < 3 ? 'completed' : failure === undefined ? 'cancelled' : 'failed',
            bytesReceived: index < 3 ? payload.bytes : name === 'denied-redirect' ? 0 : 128 * 1024,
            bytesWritten: index < 3 ? payload.bytes : 0,
            ...(failure === undefined ? {} : { failure }),
          },
        }
      }),
      checks: {
        permissionDenied: true,
        traversalRejected: true,
        rootMismatchRejected: true,
        duplicatePreserved: true,
        nonfileDestinationRejected: true,
        redirectNeverReachedBlockedOrigin: true,
        staleGrantRejected: true,
        cancelDuringQuitRequested: true,
        sentinelPreserved: true,
      },
      documents: ['native-3-1', 'native-3-2', 'native-3-3', 'native-6-1', 'native-8-1'],
      settledBaseline: zero,
      network: { requestCount: 30, blockedRequests: 0, activeStreams: 0, cancelledStreams: 9 },
      downloadShutdown: {
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
      },
      shutdownSucceeded: true,
      temporaryCleanup: true,
      final: { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    },
    nativeBeforeQuit: { ...zero, views: 1, sessions: 1, downloads: 1 },
  }
}
function report() {
  const value = receipt()
  const output = desktopReportFixture({
    receipt: value,
    acceptance: acceptFileDownloadsReceipt(value),
    profile: DOWNLOADS_PROFILE,
    sourcePaths: [
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
    ],
  })
  const observation = output['observation'] as { stderr: string[] }
  const application = observation.stderr.shift()!
  observation.stderr.unshift(
    JSON.stringify({
      event: 'bunly.host.download-shutdown',
      ...value.observations.downloadShutdown,
    })
  )
  observation.stderr.splice(2, 0, application)
  return output
}

test('download acceptance requires every ordered actual transfer outcome and fixed content digest', () => {
  assert.deepEqual(acceptFileDownloadsReceipt(receipt()), {
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
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps.pop()
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps.reverse()
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[1]!.name = 'complete'
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[0]!.outcome.bytesWritten--
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[1]!.sha256 = '0'.repeat(64)
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[4]!.outcome.status = 'completed'
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[4]!.positiveProgress = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[4]!.outcome.bytesReceived = 0
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[6]!.outcome.failure = 'network'
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[6]!.outcome.bytesReceived = 65536
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[7]!.notifications = 0
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[8]!.notifications = 257
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps[3]!.outcome.bytesReceived = 1
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptFileDownloadsReceipt(value))
  }
})

test('download acceptance distinguishes live quit ownership from settled native and final SDK state', () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => {
      r.nativeBeforeQuit.downloads = 0
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.settledBaseline.downloads = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.final.listeners = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.final.listenerErrors = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.downloadShutdown.terminalCallbacks = 13
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.downloadShutdown.cancelled = 6
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.downloadShutdown.ownedCallbacks = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.downloadShutdown.ownedStagingHandles = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.downloadShutdown.ownedDeadlineWorkers = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.downloadShutdown.passed = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.shutdownSucceeded = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.temporaryCleanup = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.network.blockedRequests = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.network.activeStreams = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.network.cancelledStreams = 7
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.checks.sentinelPreserved = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.checks.cancelDuringQuitRequested = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.documents[1] = r.observations.documents[0]!
    },
    (r: ReturnType<typeof receipt>) => {
      r.workloadMs = DOWNLOAD_WORKLOAD_MS + 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.performanceEligible = true
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptFileDownloadsReceipt(value))
  }
})

test('download receipts reject unbounded fields and filesystem or response payload additions', () => {
  for (const value of [
    { ...receipt(), destination: '/private/path' },
    { ...receipt(), observations: { ...receipt().observations, payload: 'private' } },
    { ...receipt(), failure: 'should never be accepted' },
    { ...receipt(), workloadMs: NaN },
  ])
    assert.throws(() => acceptFileDownloadsReceipt(value))
  const path = receipt()
  path.observations.documents[0] = '/private/path'
  assert.throws(() => acceptFileDownloadsReceipt(path))
})

test('download observation requires native settlement before shutdown and one post-response application receipt', () => {
  assert.equal(acceptFileDownloads(report()['observation']).transfers, 14)
  for (const mutate of [
    (lines: string[]) => {
      lines.shift()
    },
    (lines: string[]) => {
      lines.unshift(lines[0]!)
    },
    (lines: string[]) => {
      lines.splice(3, 0, lines.shift()!)
    },
    (lines: string[]) => {
      lines.unshift(lines.splice(2, 1)[0]!)
    },
    (lines: string[]) => {
      lines.push(lines.splice(2, 1)[0]!)
    },
    (lines: string[]) => {
      lines[0] = lines[0]!.replace('"terminalCallbacks":14', '"terminalCallbacks":13')
    },
    (lines: string[]) => {
      lines[0] = lines[0]!.replace('"ownedTransfers":0', '"ownedTransfers":1')
    },
  ]) {
    const value = report()['observation'] as { stderr: string[] }
    mutate(value.stderr)
    assert.throws(() => acceptFileDownloads(value))
  }
})

test('download report preserves complete shared artifact, source and observer gates', () => {
  assert.equal(acceptDownloadsReport(report()).nativeOwnershipReleased, true)
  for (const mutate of [
    (r: Record<string, unknown>) => {
      r['observerTimeoutMs'] = 46_000
    },
    (r: Record<string, unknown>) => {
      r['sourceHashes'] = []
    },
    (r: Record<string, unknown>) => {
      r['preparedMetadataBefore'] = []
    },
    (r: Record<string, unknown>) => {
      r['inputArtifactUnchanged'] = false
    },
    (r: Record<string, unknown>) => {
      const source = r['sourceHashes'] as { path: string }[]
      r['sourceHashes'] = source.filter(
        (entry) => entry.path !== 'native/cef-host/src/download_access.rs'
      )
      r['sourceHashesAfter'] = structuredClone(r['sourceHashes'])
    },
  ]) {
    const value = report()
    mutate(value)
    assert.throws(() => acceptDownloadsReport(value))
  }
})

test('download profile adds its own historical inventory and retains both native receipts', () => {
  const profile = desktopProfile('downloads')
  assert.equal(profile.profile, DOWNLOADS_PROFILE)
  assert.equal(profile.browserEntry, 'examples/file-downloads/client.ts')
  assert.ok(profile.sourceSelectors.includes('examples/file-downloads'))
  assert.equal(desktopReportProfile(DOWNLOADS_PROFILE), profile)
  for (const prior of ['windows', 'composition', 'services'])
    assert.ok(
      !desktopProfile(prior).sourceSelectors.some(
        (entry: string) => entry === 'examples/file-downloads'
      )
    )
  const events = JSON.parse(
    readFileSync(
      new URL('../benchmarks/lib/native-diagnostic-events.json', import.meta.url),
      'utf8'
    )
  ) as string[]
  for (const event of ['bunly.native.file-downloads', 'bunly.host.download-shutdown'])
    assert.equal(events.filter((entry) => entry === event).length, 1)
})

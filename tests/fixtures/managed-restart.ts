/** Synthetic acceptance-parser input only. Never publish as observed native evidence. */
import { createHash } from 'node:crypto'
import { RESTART_DEADLINE_MS } from '../../examples/managed-desktop/restart-contract.ts'
import { managedObservationContentSha256 } from '../../benchmarks/reload/managed-observation.ts'
import {
  MANAGED_RESTART_CONFIGURATION,
  MANAGED_RESTART_OBSERVER_MS,
  MANAGED_RESTART_PROFILE,
  acceptManagedRestartWorkload,
} from '../../benchmarks/reload/managed-restart-acceptance.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const zeroes = (fields: string): Record<string, number> =>
  Object.fromEntries(fields.split(' ').map((field) => [field, 0]))
export function managedRestartParserFixture(
  previousIdentities: Record<string, string> = {
    window: 'old-window',
    view: 'old-view',
    session: 'old-session',
    document: 'native-1-1',
    url: 'app://ui/index.html',
  },
  previousRendererInstance = 'old-browser-instance'
) {
  const configurationSha256 = hash(MANAGED_RESTART_CONFIGURATION)
  const context = { previousIdentities, previousRendererInstance, configurationSha256 }
  const identities = {
    window: 'new-window',
    view: 'new-view',
    session: 'new-session',
    document: 'native-1-1',
    url: 'app://ui/restart.html',
  }
  const result: Record<string, unknown> = {
    event: 'bunly.managed-restart',
    schema: 1,
    passed: true,
    backend: {
      revision: 500,
      shared: 1,
      configurationApplied: true,
      configurationSha256,
      loginAbsent: true,
      document: identities.document,
      url: identities.url,
      session: identities.session,
    },
    renderer: {
      instance: 'new-browser-instance',
      formEmpty: true,
      sessionAbsent: true,
      loginAbsent: true,
      revision: 500,
      shared: 1,
      configurationApplied: true,
      configurationSha256,
    },
    identities,
    requests: { accepted: 2, settled: 2, pending: 0 },
    final: {
      owner: {
        ...zeroes('resources attachments generations work active candidate inFlight failedCleanup'),
        closed: true,
      },
      broker: {
        ...zeroes('generations requests unsettledCallers hostCalls forcedTerminations'),
        closed: true,
        active: null,
        candidate: null,
      },
      desktop: {
        ...zeroes('resources listener queuedEvents queuedEventBytes eventOverflows'),
        closed: true,
      },
      development: {
        ...zeroes('watchedDirectories dependencies pendingChanges pendingCallers retainedBundles'),
        builds: 1,
        replacements: 1,
        closed: true,
        restartRequired: false,
      },
      nativeSnapshotPhase: 'before-last-window-close',
      native: {
        windows: 1,
        ...zeroes(
          'views sessions pending nativeDeliveryPackets nativeDeliveryBytes rpcIncomingBytes streamIncomingBytes'
        ),
      },
    },
  }
  const phases = ['process-stop', 'host-release', 'asset-service-stop', 'cef-shutdown'].flatMap(
    (phase, index) => [
      { event: 'bunly.host.shutdown-phase', phase, state: 'start' },
      ...(index === 0
        ? [
            { event: 'bunly.backend.exit', code: 0, forced: false },
            {
              event: 'bunly.native.output-drained',
              schema: 1,
              frames: 0,
              ordinaryFrames: 0,
              retainedWireBytes: 0,
              ordinaryWireBytes: 0,
            },
          ]
        : []),
      { event: 'bunly.host.shutdown-phase', phase, state: 'complete', durationMs: 1 },
    ]
  )
  const observation: Record<string, unknown> = {
    schema: 1,
    observationId: 'd'.repeat(48),
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    observedOrphans: [],
    cleanupSurvivors: [],
    elapsedMs: 1000,
    peakTreeRssBytes: 512 * 1024 * 1024,
    peakTreeThreads: 24,
    stdoutTail: [],
    stderr: [],
    environment: { os: 'Linux' },
    samples: [
      {
        elapsedMs: 50,
        rssBytes: 512 * 1024 * 1024,
        threads: 24,
        processes: [{ pid: 201, descriptors: 40 }],
      },
    ],
    nativeDiagnostics: [
      {
        event: 'bunly.managed-restart',
        schema: 1,
        passed: true,
        revision: 500,
        shared: 1,
        configurationApplied: true,
        failureCode: null,
      },
      ...phases,
      { event: 'bunly.host.shutdown', clean: true },
    ].map((value) => JSON.stringify(value)),
  }
  const resultText = JSON.stringify(result)
  const report: Record<string, unknown> = {
    schema: 1,
    profile: MANAGED_RESTART_PROFILE,
    passed: true,
    attempted: true,
    launches: 1,
    observerTimeoutMs: MANAGED_RESTART_OBSERVER_MS,
    fixtureDeadlineMs: RESTART_DEADLINE_MS,
    configurationSha256,
    configurationUnchanged: true,
    launchPathEmpty: true,
    performanceEligible: false,
    observation,
    observationSha256: 'f'.repeat(64),
    observationContentSha256: managedObservationContentSha256(observation),
    resultText,
    resultBytes: Buffer.byteLength(resultText),
    resultSha256: hash(resultText),
    acceptance: acceptManagedRestartWorkload(observation, resultText, context),
  }
  return {
    result,
    observation,
    context,
    report,
    accept: () => acceptManagedRestartWorkload(observation, JSON.stringify(result), context),
  }
}

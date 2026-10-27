import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { FORM_MARKER, LOGIN_MARKER, SESSION_MARKER } from '../examples/managed-desktop/contract.ts'
import { MANAGED_PLAN } from '../examples/managed-desktop/evidence.ts'
import {
  MANAGED_OBSERVER_MS,
  MANAGED_PROFILE,
  acceptManagedDevelopmentReport,
  acceptManagedDevelopmentWorkload,
} from '../benchmarks/reload/managed-acceptance.ts'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'

const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>
const list = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[]
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const zeroes = (names: string): Record<string, number> =>
  Object.fromEntries(names.split(' ').map((name) => [name, 0]))

/** Deliberately synthetic parser fixtures; these tests are never native qualification evidence. */
function fixture() {
  const rows: Record<string, unknown>[] = []
  let frontend = 0
  let editKind: 'backend' | 'shared' | 'frontend' | undefined
  const sources = [0, 1, 2].map((version) => {
    const frontend = version ? 1 : 0,
      shared = version === 2 ? 1 : 0
    const css = `:root { --fixture-revision: ${frontend}; }\n\n:root { --managed-shared: ${shared}; }\n`
    return { version, frontend, shared, css, sha256: hash(css) }
  })
  const row = (kind: string, revision: number, extra: Record<string, unknown> = {}) => {
    if (kind === 'replacement' || kind === 'frontend')
      editKind = kind === 'frontend' ? 'frontend' : revision === 250 ? 'shared' : 'backend'
    rows.push({
      schema: 1,
      index: rows.length,
      kind,
      revision,
      elapsedMs: kind === 'replacement' ? 10 : 0,
      passed: true,
      ...extra,
    })
  }
  const render = (revision: number) => {
    row('renderer', revision, {
      ...(editKind ? { editKind, editToRendererMs: 20 } : {}),
      renderer: {
        revision,
        shared: revision >= 250 ? 1 : 0,
        frontend,
        frontendHash: sources[frontend]!.sha256,
        frontendStyle: sources[frontend]!.frontend,
        sharedStyle: sources[frontend]!.shared,
        form: FORM_MARKER,
        session: SESSION_MARKER,
        login: LOGIN_MARKER,
        instance: 'parser-fixture-document',
        terminalSequence: revision + 1,
        terminalAck: revision,
      },
    })
    editKind = undefined
  }
  const checkpoint = (revision: number) =>
    row('checkpoint', revision, {
      snapshot: {
        heapUsed: 32 * 1024 * 1024 + revision * 10,
        rss: 256 * 1024 * 1024 + revision * 100,
        external: 1024,
        owner: {
          resources: 5,
          attachments: 5,
          generations: 1,
          active: 1,
          candidate: 0,
          inFlight: 0,
          failedCleanup: 0,
          work: 2,
        },
        broker: {
          generations: 1,
          candidate: null,
          active: revision + 1,
          mechanism: 'worker',
          hostCalls: 0,
          requests: 0,
          forcedTerminations: 0,
        },
        desktop: {
          resources: 4,
          listener: 1,
          eventOverflows: 0,
          queuedEvents: 0,
          queuedEventBytes: 0,
        },
        terminal: { terminals: 1, live: 1, driverFailures: 0 },
        development: { retainedBundles: 1, pendingChanges: 0, pendingCallers: 0 },
        accepted: revision * 3 + 1,
        settled: revision * 3,
      },
    })
  checkpoint(0)
  render(0)
  const failures: Record<number, string> = {
    100: 'syntax',
    200: 'import',
    300: 'initialization',
    425: 'closed-resource',
    450: 'runtime-handler',
  }
  for (let revision = 1; revision <= 500; revision++) {
    if (revision === 375) row('retirement', 375, { action: 'RETIRED' })
    if (revision === 250) frontend++
    row('replacement', revision, {
      action: revision === 250 ? 'both' : 'reloaded',
      shared: revision >= 250 ? 1 : 0,
    })
    if (revision % 25 === 0) checkpoint(revision)
    render(revision)
    if (failures[revision]) {
      row('failure', revision, {
        case: failures[revision],
        servingRevision: revision,
        action: 'failed',
      })
      render(revision)
    }
    if (revision === 125) {
      frontend++
      row('frontend', revision, { action: 'frontend' })
      render(revision)
    }
  }
  row('restart', 500, { action: 'restart-required' })
  render(500)
  const identities = {
    window: 'w',
    view: 'v',
    session: 's',
    terminal: 't',
    document: 'd',
    url: 'app://ui/index.html',
  }
  const result: Record<string, unknown> = {
    event: 'bunly.managed-development',
    schema: 1,
    passed: true,
    successfulReplacements: 500,
    rendererChecks: 508,
    failures: Object.fromEntries(MANAGED_PLAN.failureCases.map((name) => [name, true])),
    frontend: { notifications: 2, acknowledged: 2, sharedEdits: 1, externalHmr: false, sources },
    retirement: { accepted: 1, settled: 1, outcome: 'RETIRED', staleMutations: 0 },
    identities: { before: identities, after: { ...identities }, stable: true },
    terminal: {
      launches: 1,
      runtimeBytes: 32000,
      rendererBytes: 32000,
      runtimeHash: '01234567',
      rendererHash: '01234567',
      records: 700,
      lastSequence: 699,
      acks: 501,
      released: true,
      outputOk: true,
      processExit: {
        started: true,
        observed: true,
        exitCode: 0,
        signalCode: null,
        waitError: false,
        failure: null,
      },
      terminalClose: { started: true, observed: true, status: 0, failure: null },
    },
    requests: { accepted: 1527, settled: 1527, pending: 0 },
    restartRequired: true,
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
      terminal: zeroes(
        'terminals reservedOutputBytes owners sourceReservedBytes sourceStreams spawning live closing pendingDriverWrites driverFailures'
      ),
      development: {
        ...zeroes('watchedDirectories dependencies pendingChanges pendingCallers retainedBundles'),
        closed: true,
        restartRequired: true,
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
    observationId: 'a'.repeat(48),
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    cleanupSurvivors: [],
    observedOrphans: [],
    elapsedMs: 20000,
    peakTreeRssBytes: 512 * 1024 * 1024,
    peakTreeThreads: 24,
    stdoutTail: [],
    stderr: [],
    environment: { os: 'Linux' },
    samples: [0, 10000, 20000].map((elapsedMs) => ({
      elapsedMs,
      rssBytes: 512 * 1024 * 1024,
      threads: 24,
      processes: [{ pid: 101, descriptors: 40 }],
    })),
    nativeDiagnostics: [
      {
        event: 'bunly.managed-development',
        schema: 1,
        passed: true,
        successfulReplacements: 500,
        rendererChecks: 508,
        failureCode: null,
      },
      ...phases,
      { event: 'bunly.host.shutdown', clean: true },
    ].map((value) => JSON.stringify(value)),
  }
  const text = () => rows.map((value) => JSON.stringify(value)).join('\n') + '\n'
  return {
    rows,
    result,
    observation,
    text,
    accept: () => acceptManagedDevelopmentWorkload(observation, text(), JSON.stringify(result)),
  }
}
function reportFixture() {
  const workload = fixture(),
    acceptance = workload.accept()
  const rowsText = workload.text(),
    resultText = JSON.stringify(workload.result)
  const source = { commit: 'a'.repeat(40), clean: true, reason: 'clean-checkout' }
  const sourceHashes = [
    'scripts/qualify-managed-development.ts',
    'benchmarks/reload/managed-acceptance.ts',
    'examples/managed-desktop/main.ts',
    'examples/managed-desktop/client.ts',
    'examples/managed-desktop/evidence.ts',
    'packages/runtime/src/service-reload.ts',
    'packages/runtime/src/service-reload-runner.ts',
    'packages/runtime/src/managed-desktop.ts',
    'packages/cli/src/dev-host.ts',
    'packages/cli/src/dev-cache.ts',
    'package.json',
  ].map((path) => ({ path, sha256: 'b'.repeat(64) }))
  const entries = [
    'bunly_host',
    'libcef.so',
    'resources/bun',
    'resources/runtime.json',
    'resources/backend/main.js',
    'resources/backend/application.js',
  ].map((path) => ({ path, bytes: 100, kind: 'file', sha256: 'c'.repeat(64) }))
  const artifact = {
    schema: 1,
    metric: 'logical-installed-file-bytes-no-symlink-traversal',
    bytes: 600,
    entries,
  }
  const metadata = entries.map(({ path }) => ({ path, size: '100', mtimeNs: '1', ctimeNs: '1' }))
  const report: Record<string, unknown> = {
    schema: 1,
    profile: MANAGED_PROFILE,
    passed: true,
    target: 'linux-x64',
    bun: '1.4.3',
    observerTimeoutMs: MANAGED_OBSERVER_MS,
    successfulReplacementPlan: 500,
    launchPlan: 1,
    performanceEligible: false,
    sourceBefore: source,
    sourceAfter: { ...source },
    sourceHashes,
    sourceHashesAfter: structuredClone(sourceHashes),
    nativeSource: {
      declaredCommit: 'd'.repeat(40),
      tree: 'e'.repeat(40),
      provenance: 'explicit-caller-selected-build-source-with-identical-current-native-tree',
    },
    inputHostSha256: 'c'.repeat(64),
    runtimeIdentity: {
      event: 'cef-binary-identity',
      cefVersion: '156.0.7',
      chromiumVersion: '156.0.8078.17',
      source: 'exported-api',
      sha256: 'c'.repeat(64),
    },
    cache: {
      key: 'f'.repeat(64),
      assemblies: 1,
      cold: { cacheHit: false, durationMs: 100, verifiedBytes: 600 },
      warm: { cacheHit: true, durationMs: 50, verifiedBytes: 600 },
      warmNativeCopies: 0,
      warmNativeCompilations: 0,
    },
    inputArtifactUnchanged: true,
    preparedArtifactUnchanged: true,
    preparedFileMetadataUnchanged: true,
    launchPathEmpty: true,
    inputArtifact: artifact,
    inputArtifactAfter: structuredClone(artifact),
    preparedArtifact: structuredClone(artifact),
    preparedArtifactAfter: structuredClone(artifact),
    preparedFileMetadataBefore: metadata,
    preparedFileMetadataAfter: structuredClone(metadata),
    bundledBun: {
      version: '1.4.3',
      path: 'resources/bun',
      sha256: 'c'.repeat(64),
      observationSha256: 'b'.repeat(64),
      observation: { ...workload.observation, stdoutTail: ['1.4.3'], nativeDiagnostics: [] },
    },
    trials: [
      {
        index: 0,
        passed: true,
        observation: workload.observation,
        observationSha256: 'a'.repeat(64),
        rowsText,
        resultText,
        rowsBytes: Buffer.byteLength(rowsText),
        resultBytes: Buffer.byteLength(resultText),
        rowsSha256: hash(rowsText),
        resultSha256: hash(resultText),
        acceptance,
        processResources: acceptance.processResources,
      },
    ],
  }
  return report
}
test('fixed native workload replay requires all500 source replacements, renderer receipts and ordinary shutdown', () => {
  const value = fixture().accept()
  expect(value.successfulReplacements).toBe(500)
  expect(value.rendererChecks).toBe(508)
  expect(value.performanceEligible).toBe(false)
  expect(value.heap.allowanceBytes).toBe(32 * 1024 * 1024)
  expect(value.ownerRss.allowanceBytes).toBe(256 * 1024 * 1024)
})
test('fixed plan rejects omitted, duplicate, moved, failed and forged-revision rows', () => {
  const changes: ((rows: Record<string, unknown>[]) => void)[] = [
    (rows) => {
      rows.splice(100, 1)
    },
    (rows) => {
      rows.splice(100, 0, rows[100]!)
    },
    (rows) => {
      rows[100]!['passed'] = false
    },
    (rows) => {
      rows[100]!['index'] = 99
    },
    (rows) => {
      rows.find((row) => row['kind'] === 'failure')!['revision'] = 99
    },
    (rows) => {
      rows.find((row) => row['kind'] === 'renderer' && row['revision'] === 200)!['revision'] = 199
    },
    (rows) => {
      const [last] = rows.splice(100, 1)
      rows.splice(101, 0, last!)
      rows.forEach((row, index) => {
        row['index'] = index
      })
    },
  ]
  for (const change of changes) {
    const value = fixture()
    change(value.rows)
    expect(value.accept).toThrow()
  }
})
test('renderer, terminal and accepted-request continuity cannot be replaced with a success flag', () => {
  const changes: ((value: ReturnType<typeof fixture>) => void)[] = [
    (value) => {
      object(value.rows.find((row) => row['kind'] === 'renderer')!['renderer'])['form'] = 'reset'
    },
    (value) => {
      object(
        value.rows.find((row) => row['kind'] === 'renderer' && row['revision'] === 300)!['renderer']
      )['frontendHash'] = 'f'.repeat(64)
    },
    (value) => {
      object(
        value.rows.find((row) => row['kind'] === 'renderer' && row['revision'] === 300)!['renderer']
      )['sharedStyle'] = 0
    },
    (value) => {
      list(object(value.result['frontend'])['sources'])[1]!['css'] =
        ':root { --fixture-revision: 0; }'
    },
    (value) => {
      object(
        value.rows.find((row) => row['kind'] === 'renderer' && row['revision'] === 400)!['renderer']
      )['instance'] = 'new-document'
    },
    (value) => {
      object(object(value.result['identities'])['after'])['session'] = 'new-session'
    },
    (value) => {
      object(value.result['terminal'])['rendererHash'] = 'deadbeef'
    },
    (value) => {
      object(value.result['terminal'])['acks'] = 500
    },
    (value) => {
      object(value.result['requests'])['settled'] = 1526
    },
    (value) => {
      object(value.result['retirement'])['staleMutations'] = 1
    },
    (value) => {
      object(object(value.result['final'])['owner'])['resources'] = 1
    },
    (value) => {
      object(object(value.result['final'])['native'])['streamIncomingBytes'] = 1
    },
    (value) => {
      object(object(value.result['terminal'])['processExit'])['observed'] = false
    },
  ]
  for (const change of changes) {
    const value = fixture()
    change(value)
    expect(value.accept).toThrow()
  }
})
test('predeclared heap/RSS sentinels and completed-generation cleanup reject retained growth', () => {
  for (const [field, allowance] of [
    ['heapUsed', 32 * 1024 * 1024],
    ['rss', 256 * 1024 * 1024],
  ] as const) {
    const value = fixture()
    for (const row of value.rows.filter(
      (row) => row['kind'] === 'checkpoint' && Number(row['revision']) >= 400
    )) {
      const snapshot = object(row['snapshot'])
      snapshot[field] = Number(snapshot[field]) + allowance + 1
    }
    expect(value.accept).toThrow('finite retention sentinel')
  }
  for (const [section, field] of [
    ['owner', 'resources'],
    ['broker', 'forcedTerminations'],
    ['development', 'retainedBundles'],
  ] as const) {
    const value = fixture(),
      row = value.rows.find((row) => row['kind'] === 'checkpoint' && row['revision'] === 500)!
    const state = object(object(row['snapshot'])[section])
    state[field] = Number(state[field]) + 1
    expect(value.accept).toThrow()
  }
})
test('the workload file must match one retained native completion marker before backend exit', () => {
  for (const mode of ['missing', 'duplicate', 'wrong-count', 'late', 'tail-only']) {
    const value = fixture(),
      events = value.observation['nativeDiagnostics'] as string[]
    const marker = events.shift()!
    if (mode === 'duplicate') events.unshift(marker, marker)
    if (mode === 'wrong-count')
      events.unshift(JSON.stringify({ ...JSON.parse(marker), rendererChecks: 507 }))
    if (mode === 'late') events.push(marker)
    if (mode === 'tail-only') value.observation['stderr'] = [marker]
    expect(value.accept).toThrow()
  }
})
test('native watchdog, malformed drainage, missing shutdown, orphan or forced child exit remains failure', () => {
  for (const change of [
    { exitCode: 78 },
    { timedOut: true },
    { observedOrphans: [102] },
    { cleanupSurvivors: [102] },
    { outputOverflow: true },
  ]) {
    const value = fixture()
    Object.assign(value.observation, change)
    expect(value.accept).toThrow()
  }
  for (const event of ['bunly.native.output-drained', 'bunly.host.shutdown']) {
    const value = fixture()
    value.observation['nativeDiagnostics'] = (
      value.observation['nativeDiagnostics'] as string[]
    ).filter((line) => JSON.parse(line).event !== event)
    expect(value.accept).toThrow()
  }
})
test('macOS completion requires positively qualified existing helper/clone cleanup', () => {
  const value = fixture()
  value.observation['environment'] = { os: 'Darwin' }
  expect(value.accept).toThrow('positively qualified')
  value.observation['postExitCleanup'] = {
    schema: 1,
    profile: 'macos-verified-code-sign-clone-v1',
    passed: true,
    qualified: true,
    status: 'completed',
    elapsedMs: 50,
    limitMs: 3000,
    observedClones: 1,
    cloneInventory: {
      prelaunchEntries: 0,
      entryLimit: 256,
      scope: 'new-names-after-prelaunch-snapshot',
    },
    helpers: [
      {
        pid: 102,
        creationTime: 1,
        role: 'code-sign-clone-cleanup',
        executableSha256: 'a'.repeat(64),
        ownership: 'observed-root-child-and-matching-clone-inode',
        processExited: true,
        cloneRemoved: true,
        completed: true,
      },
    ],
  }
  expect(value.accept).not.toThrow()
  object(value.observation['postExitCleanup'])['elapsedMs'] = 3001
  expect(value.accept).toThrow()
})
test('report replay binds raw rows, sources, native inventory, observed Bun and warm reuse', () => {
  expect(acceptManagedDevelopmentReport(reportFixture()).successfulReplacements).toBe(500)
  const changes: ((value: Record<string, unknown>) => void)[] = [
    (value) => {
      object(value['cache'])['assemblies'] = 2
    },
    (value) => {
      object(value['cache'])['warmNativeCopies'] = 1
    },
    (value) => {
      object(value['sourceAfter'])['commit'] = 'f'.repeat(40)
    },
    (value) => {
      list(value['sourceHashesAfter'])[0]!['sha256'] = 'f'.repeat(64)
    },
    (value) => {
      list(object(value['preparedArtifactAfter'])['entries'])[0]!['sha256'] = 'f'.repeat(64)
    },
    (value) => {
      list(value['preparedFileMetadataAfter'])[0]!['mtimeNs'] = '2'
    },
    (value) => {
      object(object(value['bundledBun'])['observation'])['stdoutTail'] = ['1.4.2']
    },
    (value) => {
      list(value['trials'])[0]!['rowsSha256'] = 'f'.repeat(64)
    },
    (value) => {
      list(value['trials']).push(structuredClone(list(value['trials'])[0]!))
    },
    (value) => {
      value['performanceEligible'] = true
    },
  ]
  for (const change of changes) {
    const value = reportFixture()
    change(value)
    expect(() => acceptManagedDevelopmentReport(value)).toThrow()
  }
})
test('explicit sanitized export replay preserves failures and never fabricates live observation identity', () => {
  const report = reportFixture()
  for (const observation of [
    object(list(report['trials'])[0]!['observation']),
    object(object(report['bundledBun'])['observation']),
  ]) {
    delete observation['observationId']
    observation['observationExport'] = { schema: 1, correlation: 'omitted' }
  }
  report['nativeEvidenceExport'] = {
    schema: 1,
    correlation: 'not-retained',
    redactions: ['fixture-nonces'],
  }
  expect(() => acceptManagedDevelopmentReport(report)).toThrow('exported-observation validator')
  const decoded = decodeExportedNativeReport(report)
  expect(acceptManagedDevelopmentReport(decoded).successfulReplacements).toBe(500)
  expect(object(list(decoded['trials'])[0]!['observation'])['observationId']).toBeUndefined()
  object(list(report['trials'])[0]!['observation'])['exitCode'] = 2
  expect(() => acceptManagedDevelopmentReport(decodeExportedNativeReport(report))).toThrow(
    'unexpected exit 2'
  )
})

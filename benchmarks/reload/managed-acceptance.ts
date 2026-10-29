/** Independent replay of the fixed native managed-development workload and ordinary exit gates. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  FORM_MARKER,
  LOGIN_MARKER,
  SESSION_MARKER,
} from '../../examples/managed-desktop/contract.ts'
import { MANAGED_PLAN } from '../../examples/managed-desktop/evidence.ts'
import { assertCleanCommand, validateCommandObservation } from '../lib/observed-command.ts'
import { quantile } from '../lib/statistics.ts'
import { reloadObservationResources } from './acceptance.ts'
import { acceptManagedNativeExit, managedObservationContentSha256 } from './managed-observation.ts'
import {
  MANAGED_RESTART_CONFIGURATION,
  acceptManagedRestartReport,
} from './managed-restart-acceptance.ts'
import { acceptPreparedFileMetadata } from './prepared-file-metadata.ts'

export const MANAGED_PROFILE = 'native-managed-development-v1'
/** Whole-workload observation budget only; no native phase deadline is changed. */
export const MANAGED_OBSERVER_MS = 180_000
export const managedSourceSelectors = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'tsconfig.browser.json',
  'packages/contracts/src',
  'packages/client/src',
  'packages/runtime/src',
  'packages/cli/src',
  'examples/managed-desktop',
  'benchmarks/reload',
  'benchmarks/lib',
  'benchmarks/foundation',
  'scripts',
  'native/cef-host',
] as const

const record = (value: unknown, name: string): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), name)
  return value as Record<string, unknown>
}
const integer = (value: unknown, name: string, maximum = 1_000_000_000): number => {
  assert.ok(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum, name)
  return Number(value)
}
const finite = (value: unknown, name: string, maximum = MANAGED_OBSERVER_MS): number => {
  assert.ok(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum,
    name
  )
  return value
}
const checksum = (value: unknown, name: string, length = 64): string => {
  assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value), name)
  return value
}
const exact = (value: Record<string, unknown>, names: readonly string[], context: string): void => {
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), context)
}
const zero = (value: Record<string, unknown>, names: readonly string[], context: string): void => {
  for (const name of names) assert.equal(value[name], 0, `${context}: ${name}`)
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const failureRevisions = {
  syntax: 100,
  import: 200,
  initialization: 300,
  'closed-resource': 425,
  'runtime-handler': 450,
} as const

/** Independently reconstruct the complete finite plan; counts alone cannot hide omissions. */
function requireRowPlan(rows: readonly Record<string, unknown>[]): void {
  const expected: { kind: string; revision: number; case?: string }[] = [
    { kind: 'checkpoint', revision: 0 },
    { kind: 'renderer', revision: 0 },
  ]
  for (let revision = 1; revision <= MANAGED_PLAN.replacements; revision++) {
    expected.push({ kind: 'replacement', revision })
    if (revision % MANAGED_PLAN.checkpointEvery === 0)
      expected.push({ kind: 'checkpoint', revision })
    expected.push({ kind: 'renderer', revision })
    const failure = Object.entries(failureRevisions).find(([, at]) => at === revision)?.[0]
    if (failure)
      expected.push({ kind: 'failure', revision, case: failure }, { kind: 'renderer', revision })
    if (revision === MANAGED_PLAN.frontendAfter)
      expected.push({ kind: 'frontend', revision }, { kind: 'renderer', revision })
  }
  expected.push(
    { kind: 'restart', revision: MANAGED_PLAN.replacements },
    { kind: 'renderer', revision: MANAGED_PLAN.replacements }
  )
  const observed = rows
    .filter((row) => row['kind'] !== 'retirement')
    .map((row) => ({
      kind: row['kind'],
      revision: row['revision'],
      ...(row['case'] === undefined ? {} : { case: row['case'] }),
    }))
  assert.deepEqual(observed, expected, 'Workload did not execute the exact fixed scenario order')
  const retirement = rows.findIndex((row) => row['kind'] === 'retirement')
  assert.ok(
    retirement >
      rows.findIndex(
        (row) => row['kind'] === 'renderer' && row['revision'] === MANAGED_PLAN.pendingAt - 1
      )
  )
  assert.ok(
    retirement <
      rows.findIndex(
        (row) => row['kind'] === 'renderer' && row['revision'] === MANAGED_PLAN.pendingAt
      )
  )
}
function distribution(values: readonly number[]) {
  assert.ok(values.length > 0 && values.length <= 2000)
  for (const value of values) finite(value, 'Invalid edit duration')
  return {
    count: values.length,
    min: Math.min(...values),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: Math.max(...values),
    method: 'correlated within-launch samples; no independent-launch confidence interval',
  }
}
function parseRows(text: unknown): Record<string, unknown>[] {
  assert.ok(
    typeof text === 'string' &&
      Buffer.byteLength(text) > 0 &&
      Buffer.byteLength(text) <= 8 * 1024 * 1024,
    'Missing bounded raw workload rows'
  )
  assert.ok(text.endsWith('\n'), 'Incomplete final workload row')
  const lines = text.trimEnd().split('\n')
  assert.ok(
    lines.length >= 1000 && lines.length <= 1600,
    'Incomplete or excessive workload row plan'
  )
  return lines.map((line, index) => {
    const row = record(JSON.parse(line), 'Malformed workload row')
    assert.equal(row['schema'], 1)
    assert.equal(row['index'], index, 'Workload row identity duplicated, omitted or reordered')
    assert.equal(row['passed'], true, 'Failed workload row cannot be retried into a pass')
    integer(row['revision'], 'Invalid row revision', MANAGED_PLAN.replacements)
    finite(row['elapsedMs'], 'Invalid row elapsed time')
    assert.ok(
      [
        'replacement',
        'checkpoint',
        'failure',
        'frontend',
        'retirement',
        'restart',
        'renderer',
      ].includes(String(row['kind'])),
      'Unknown workload scenario'
    )
    return row
  })
}
function acceptFinal(result: Record<string, unknown>, os: unknown): void {
  const final = record(result['final'], 'Missing final ownership evidence')
  const owner = record(final['owner'], 'Missing final owner accounting')
  zero(
    owner,
    [
      'resources',
      'attachments',
      'generations',
      'work',
      'active',
      'candidate',
      'inFlight',
      'failedCleanup',
    ],
    'Unreleased final owner state'
  )
  const broker = record(final['broker'], 'Missing final broker accounting')
  assert.equal(broker['closed'], true)
  assert.equal(broker['active'], null)
  assert.equal(broker['candidate'], null)
  zero(
    broker,
    ['generations', 'requests', 'unsettledCallers', 'hostCalls', 'forcedTerminations'],
    'Unreleased final broker state'
  )
  const desktop = record(final['desktop'], 'Missing desktop accounting')
  assert.equal(desktop['closed'], true)
  zero(
    desktop,
    ['resources', 'listener', 'queuedEvents', 'queuedEventBytes', 'eventOverflows'],
    'Retained desktop event state'
  )
  const terminal = record(final['terminal'], 'Missing terminal accounting')
  zero(
    terminal,
    [
      'terminals',
      'reservedOutputBytes',
      'owners',
      'sourceReservedBytes',
      'sourceStreams',
      'spawning',
      'live',
      'closing',
      'pendingDriverWrites',
      'driverFailures',
    ],
    'Unreleased terminal reservations'
  )
  const development = record(final['development'], 'Missing development accounting')
  assert.equal(development['closed'], true)
  assert.equal(development['restartRequired'], true)
  zero(
    development,
    ['watchedDirectories', 'dependencies', 'pendingChanges', 'pendingCallers', 'retainedBundles'],
    'Retained development resources'
  )
  const native = record(final['native'], 'Missing final native state')
  assert.equal(final['nativeSnapshotPhase'], 'before-last-window-close')
  assert.equal(native['windows'], 1, 'The final window stays alive until native diagnostics finish')
  zero(
    native,
    [
      'views',
      'sessions',
      'pending',
      'nativeDeliveryPackets',
      'nativeDeliveryBytes',
      'rpcIncomingBytes',
      'streamIncomingBytes',
    ],
    'Native resources were not closed'
  )
  const process = record(
    record(result['terminal'], 'Missing terminal receipt')['processExit'],
    'Missing actual terminal child exit'
  )
  assert.equal(process['started'], true)
  assert.equal(process['observed'], true)
  assert.equal(process['exitCode'], 0)
  assert.equal(process['signalCode'], null)
  assert.equal(process['waitError'], false)
  assert.equal(process['failure'], null)
  const closure = record(
    record(result['terminal'], 'Missing terminal receipt')['terminalClose'],
    'Missing actual PTY close'
  )
  assert.equal(closure['observed'], true)
  assert.equal(closure['started'], true)
  assert.equal(closure['failure'], null)
  assert.ok(
    closure['status'] === 0 || (os === 'Linux' && closure['status'] === 1),
    'Unknown PTY close outcome'
  )
}

export function acceptManagedDevelopmentWorkload(
  observationInput: unknown,
  rowsText: unknown,
  resultText: unknown
) {
  const { observation, events, backendExit, shutdown } = acceptManagedNativeExit(observationInput)
  assert.equal(
    events.some((event) => event['event'] === 'bunly.managed-restart'),
    false,
    'The soak and full restart require separate observed launches'
  )
  const rows = parseRows(rowsText)
  requireRowPlan(rows)
  assert.ok(
    typeof resultText === 'string' &&
      Buffer.byteLength(resultText) > 0 &&
      Buffer.byteLength(resultText) <= 2 * 1024 * 1024,
    'Missing bounded workload result'
  )
  const result = record(JSON.parse(resultText), 'Missing workload result')
  assert.equal(result['schema'], 1)
  assert.equal(result['event'], 'bunly.managed-development')
  assert.equal(result['passed'], true, 'Workload did not complete')
  assert.equal(result['failureCode'], undefined)
  assert.equal(result['successfulReplacements'], MANAGED_PLAN.replacements)
  assert.equal(result['restartRequired'], true)
  const markers = events.filter((event) => event['event'] === 'bunly.managed-development')
  assert.deepEqual(
    markers,
    [
      {
        event: 'bunly.managed-development',
        schema: 1,
        passed: true,
        successfulReplacements: MANAGED_PLAN.replacements,
        rendererChecks: result['rendererChecks'],
        failureCode: null,
      },
    ],
    'Exactly one matching workload completion receipt must belong to the observed launch'
  )
  assert.ok(events.indexOf(markers[0]!) < backendExit, 'Workload receipt followed backend shutdown')
  const replacements = rows.filter((row) => row['kind'] === 'replacement')
  assert.deepEqual(
    replacements.map((row) => row['revision']),
    Array.from({ length: MANAGED_PLAN.replacements }, (_, index) => index + 1),
    'Fixed successful replacement plan was not completed'
  )
  for (const row of replacements) {
    assert.equal(row['action'], row['revision'] === MANAGED_PLAN.sharedAt ? 'both' : 'reloaded')
    assert.equal(row['shared'], Number(row['revision']) >= MANAGED_PLAN.sharedAt ? 1 : 0)
  }
  const failures = rows.filter((row) => row['kind'] === 'failure')
  assert.deepEqual(
    failures.map((row) => row['case']).sort(),
    [...MANAGED_PLAN.failureCases].sort(),
    'Every fixed failure must execute once'
  )
  const failureResult = record(result['failures'], 'Missing retained failure controls')
  exact(failureResult, MANAGED_PLAN.failureCases, 'Failure result plan differs')
  for (const row of failures) {
    assert.equal(
      row['servingRevision'],
      row['revision'],
      'Failed candidate changed the serving revision'
    )
    assert.equal(failureResult[String(row['case'])], true)
    assert.equal(row['action'], 'failed')
  }
  const frontend = rows.filter((row) => row['kind'] === 'frontend')
  assert.equal(frontend.length, 1)
  assert.equal(frontend[0]!['revision'], MANAGED_PLAN.frontendAfter)
  assert.equal(frontend[0]!['action'], 'frontend')
  const frontendResult = record(result['frontend'], 'Missing frontend outcomes')
  assert.equal(frontendResult['notifications'], 2)
  assert.equal(frontendResult['acknowledged'], 2)
  assert.equal(frontendResult['sharedEdits'], 1)
  assert.equal(
    frontendResult['externalHmr'],
    false,
    'Do not turn fixed callback coverage into an external tooling claim'
  )
  const frontendSources = frontendResult['sources']
  assert.ok(
    Array.isArray(frontendSources) && frontendSources.length === 3,
    'Missing actual frontend source versions'
  )
  for (let version = 0; version < frontendSources.length; version++) {
    const source = record(frontendSources[version], 'Missing bounded frontend source')
    assert.equal(source['version'], version)
    assert.equal(source['frontend'], version === 0 ? 0 : 1)
    assert.equal(source['shared'], version === 2 ? 1 : 0)
    assert.ok(
      typeof source['css'] === 'string' &&
        Buffer.byteLength(source['css']) > 0 &&
        Buffer.byteLength(source['css']) <= 8192
    )
    assert.equal(checksum(source['sha256'], 'Missing frontend source digest'), hash(source['css']))
    const declarations =
      /^\s*:root\s*\{\s*--fixture-revision\s*:\s*([01])\s*;?\s*\}\s*:root\s*\{\s*--managed-shared\s*:\s*([01])\s*;?\s*\}\s*$/.exec(
        source['css']
      )
    assert.ok(declarations, 'Unexpected fixed frontend source syntax')
    assert.equal(Number(declarations[1]), source['frontend'])
    assert.equal(Number(declarations[2]), source['shared'])
  }
  const retirement = rows.filter((row) => row['kind'] === 'retirement')
  assert.equal(retirement.length, 1)
  assert.equal(retirement[0]!['revision'], MANAGED_PLAN.pendingAt)
  const retired = record(result['retirement'], 'Missing retirement result')
  assert.equal(retired['accepted'], 1)
  assert.equal(retired['settled'], 1)
  assert.equal(
    retired['outcome'],
    'RETIRED',
    'This fixed pending request must settle with retirement'
  )
  assert.equal(
    retirement[0]!['action'],
    retired['outcome'],
    'Retirement row differs from final caller outcome'
  )
  assert.equal(retired['staleMutations'], 0)
  const restart = rows.filter((row) => row['kind'] === 'restart')
  assert.equal(restart.length, 1)
  assert.equal(restart[0]!['revision'], MANAGED_PLAN.replacements)
  assert.equal(restart[0]!['action'], 'restart-required')
  const rendered = rows.filter((row) => row['kind'] === 'renderer')
  assert.equal(result['rendererChecks'], rendered.length)
  assert.equal(rendered.length, MANAGED_PLAN.replacements + 8)
  const seenRevisions = new Set<number>()
  let instance: string | undefined,
    lastSequence = -1,
    initialTicks: number | undefined,
    lastTicks = -1
  for (const row of rendered) {
    const receipt = record(row['renderer'], 'Actual renderer state receipt is missing')
    assert.equal(receipt['revision'], row['revision'])
    assert.equal(receipt['form'], FORM_MARKER, 'Unsaved form state changed across a backend edit')
    assert.equal(
      receipt['session'],
      SESSION_MARKER,
      'Session storage changed across a backend edit'
    )
    assert.equal(
      receipt['login'],
      LOGIN_MARKER,
      'Synthetic login state changed across a backend edit'
    )
    assert.equal(receipt['shared'], Number(row['revision']) >= MANAGED_PLAN.sharedAt ? 1 : 0)
    const expectedFrontend =
      Number(row['revision']) >= MANAGED_PLAN.sharedAt
        ? 2
        : Number(row['index']) > Number(frontend[0]!['index'])
          ? 1
          : 0
    assert.equal(
      receipt['frontend'],
      expectedFrontend,
      'Source update acknowledgement differs from fixed edit order'
    )
    const applied = record(frontendSources[expectedFrontend], 'Missing applied frontend source')
    assert.equal(
      receipt['frontendHash'],
      applied['sha256'],
      'Browser did not acknowledge the actual edited stylesheet bytes'
    )
    assert.equal(
      receipt['frontendStyle'],
      applied['frontend'],
      'Computed frontend style did not change with source'
    )
    assert.equal(
      receipt['sharedStyle'],
      applied['shared'],
      'Computed shared style did not change with source'
    )
    assert.ok(
      typeof receipt['instance'] === 'string' &&
        receipt['instance'].length > 0 &&
        receipt['instance'].length <= 256
    )
    instance ??= receipt['instance']
    assert.equal(receipt['instance'], instance, 'Renderer document was replaced')
    const sequence = integer(
      receipt['terminalSequence'],
      'Invalid terminal record sequence',
      20_000
    )
    assert.ok(sequence >= lastSequence, 'Terminal records moved backwards')
    lastSequence = sequence
    // Before final closure: one ready record and revision+1 acknowledgements.
    // The remaining exact numbered records were produced autonomously by the child.
    const ticks = sequence - Number(row['revision']) - 1
    assert.ok(
      ticks >= 0 && ticks >= lastTicks,
      'Autonomous terminal output was lost or moved backwards'
    )
    initialTicks ??= ticks
    lastTicks = ticks
    assert.equal(
      receipt['terminalAck'],
      row['revision'],
      'Terminal did not receive the serving generation acknowledgement'
    )
    seenRevisions.add(Number(row['revision']))
  }
  assert.deepEqual(
    [...seenRevisions].sort((a, b) => a - b),
    Array.from({ length: 501 }, (_, index) => index),
    'Renderer did not verify every successful revision'
  )
  assert.ok(
    initialTicks !== undefined && lastTicks > initialTicks,
    'No autonomous terminal output continued during backend edits'
  )
  const rendererTimings: Record<'backend' | 'shared' | 'frontend', number[]> = {
    backend: [],
    shared: [],
    frontend: [],
  }
  let pendingEdit: { kind: 'backend' | 'shared' | 'frontend'; minimumMs: number } | undefined
  for (const row of rows) {
    if (row['kind'] === 'replacement' || row['kind'] === 'frontend') {
      assert.equal(
        pendingEdit,
        undefined,
        'An edited source was never acknowledged by the renderer'
      )
      pendingEdit = {
        kind:
          row['kind'] === 'frontend'
            ? 'frontend'
            : row['revision'] === MANAGED_PLAN.sharedAt
              ? 'shared'
              : 'backend',
        minimumMs: Number(row['elapsedMs']),
      }
    } else if (row['kind'] === 'renderer') {
      if (pendingEdit) {
        assert.equal(row['editKind'], pendingEdit.kind)
        const elapsed = finite(
          row['editToRendererMs'],
          'Missing bounded source-write-to-renderer timing'
        )
        assert.ok(
          elapsed >= pendingEdit.minimumMs,
          'Renderer acknowledgement predates the completed source update'
        )
        rendererTimings[pendingEdit.kind].push(elapsed)
        pendingEdit = undefined
      } else {
        assert.equal(row['editKind'], undefined)
        assert.equal(row['editToRendererMs'], undefined)
      }
    }
  }
  assert.equal(pendingEdit, undefined)
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(rendererTimings).map(([kind, values]) => [kind, values.length])
    ),
    { backend: 499, shared: 1, frontend: 1 }
  )
  const identities = record(result['identities'], 'Missing native identity continuity')
  assert.equal(identities['stable'], true)
  const first = record(identities['before'], 'Missing initial native identity')
  exact(
    first,
    ['window', 'view', 'session', 'terminal', 'document', 'url'],
    'Unknown native identity fields'
  )
  for (const value of Object.values(first))
    assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 512)
  assert.deepEqual(identities['after'], first, 'Native resource or document identity changed')
  const terminal = record(result['terminal'], 'Missing continuous terminal evidence')
  assert.equal(terminal['launches'], 1)
  assert.equal(terminal['acks'], 501)
  const bytes = integer(terminal['runtimeBytes'], 'Missing terminal bytes', 4 * 1024 * 1024)
  assert.ok(bytes > 0)
  assert.equal(terminal['rendererBytes'], bytes)
  assert.equal(
    checksum(terminal['runtimeHash'], 'Invalid runtime stream checksum', 8),
    checksum(terminal['rendererHash'], 'Invalid renderer stream checksum', 8)
  )
  const records = integer(terminal['records'], 'Invalid terminal record count', 20_000)
  assert.ok(
    records > 503,
    'Terminal produced no autonomous records beyond ready, acknowledgements and final closure'
  )
  assert.ok(
    records - 503 >= lastTicks,
    'Final autonomous output receipt omitted already acknowledged records'
  )
  assert.equal(terminal['lastSequence'], records - 1)
  assert.ok(Number(terminal['lastSequence']) >= lastSequence)
  assert.equal(terminal['released'], true)
  assert.equal(terminal['outputOk'], true)
  const requests = record(result['requests'], 'Missing accepted request accounting')
  const accepted = integer(requests['accepted'], 'Missing accepted requests', 10000)
  assert.ok(accepted >= 1500)
  assert.equal(requests['settled'], accepted)
  assert.equal(requests['pending'], 0)
  const checkpoints = rows.filter((row) => row['kind'] === 'checkpoint')
  assert.deepEqual(
    checkpoints.map((row) => row['revision']),
    Array.from({ length: 21 }, (_, index) => index * MANAGED_PLAN.checkpointEvery),
    'Incomplete resource/heap checkpoint plan'
  )
  let initialResources: number | undefined
  const heaps: number[] = [],
    rss: number[] = []
  for (const checkpoint of checkpoints) {
    const state = record(checkpoint['snapshot'], 'Missing resource checkpoint')
    heaps.push(integer(state['heapUsed'], 'Invalid post-GC heap', 2 ** 40))
    rss.push(integer(state['rss'], 'Invalid owner RSS', 2 ** 40))
    integer(state['external'], 'Invalid owner external allocation', 2 ** 40)
    const owned = record(state['owner'], 'Missing owner checkpoint')
    const resources = integer(owned['resources'], 'Invalid owner resource count', 64)
    initialResources ??= resources
    assert.ok(initialResources >= 4)
    assert.equal(
      resources,
      initialResources,
      'Stable resource reservations grew across completed edits'
    )
    assert.equal(owned['active'], 1)
    assert.equal(owned['candidate'], 0)
    assert.equal(owned['generations'], 1)
    assert.equal(owned['attachments'], initialResources)
    zero(owned, ['failedCleanup', 'inFlight'], 'Unsettled checkpoint owner operations')
    assert.ok(integer(owned['work'], 'Unbounded owner work', 256) <= 256)
    const broker = record(state['broker'], 'Missing broker checkpoint')
    assert.equal(broker['generations'], 1)
    assert.equal(broker['candidate'], null)
    assert.equal(broker['mechanism'], 'worker')
    zero(
      broker,
      ['hostCalls', 'forcedTerminations'],
      'Unsettled checkpoint resource invocation or forced generation retirement'
    )
    integer(broker['requests'], 'Unbounded generation request admission', 64)
    const desktop = record(state['desktop'], 'Missing desktop checkpoint')
    assert.equal(desktop['listener'], 1)
    assert.equal(desktop['eventOverflows'], 0)
    integer(desktop['queuedEvents'], 'Unbounded desktop events', initialResources * 64)
    integer(desktop['queuedEventBytes'], 'Unbounded desktop event bytes', initialResources * 32768)
    const pty = record(state['terminal'], 'Missing terminal checkpoint')
    assert.equal(pty['terminals'], 1)
    assert.equal(pty['live'], 1)
    assert.equal(pty['driverFailures'], 0)
    const dev = record(state['development'], 'Missing development checkpoint')
    assert.equal(dev['retainedBundles'], 1)
    assert.equal(dev['pendingChanges'], 0)
    assert.equal(dev['pendingCallers'], 0)
    const currentAccepted = integer(state['accepted'], 'Missing checkpoint request count', 10000)
    const currentSettled = integer(state['settled'], 'Missing checkpoint settled requests', 10000)
    assert.ok(currentAccepted >= currentSettled && currentAccepted - currentSettled <= 2)
  }
  const firstHeap = quantile(heaps.slice(1, 6), 0.5),
    lastHeap = quantile(heaps.slice(-5), 0.5)
  assert.ok(
    lastHeap - firstHeap <= MANAGED_PLAN.heapAllowanceBytes,
    'Post-warmup retained heap exceeded the predeclared 32-MiB finite retention sentinel'
  )
  const firstRss = quantile(rss.slice(1, 6), 0.5),
    lastRss = quantile(rss.slice(-5), 0.5)
  assert.ok(
    lastRss - firstRss <= MANAGED_PLAN.rssAllowanceBytes,
    'Owner-process RSS exceeded the predeclared 256-MiB finite retention sentinel'
  )
  acceptFinal(result, observation.environment['os'])
  return Object.freeze({
    successfulReplacements: replacements.length,
    failureCases: [...MANAGED_PLAN.failureCases],
    rendererChecks: rendered.length,
    nativeIdentitiesStable: true,
    terminalLaunches: 1,
    terminalBytes: bytes,
    terminalRecords: records,
    terminalAutonomousRecords: records - 503,
    terminalChecksum: {
      algorithm: 'FNV-1a-32-plus-exact-monotonic-record-plan',
      value: terminal['runtimeHash'],
    },
    requestsAccepted: accepted,
    requestsSettled: accepted,
    pendingAtShutdown: 0,
    backendEditMs: distribution(replacements.map((row) => Number(row['elapsedMs']))),
    editToRendererMs: {
      backend: distribution(rendererTimings.backend),
      shared: distribution(rendererTimings.shared),
      frontend: distribution(rendererTimings.frontend),
      scope:
        'source write through admitted replacement/style update and native renderer state acknowledgement; separate from bundle-and-reload timing',
    },
    heap: {
      checkpoints: heaps,
      firstPostWarmupMedianBytes: firstHeap,
      finalMedianBytes: lastHeap,
      differenceBytes: lastHeap - firstHeap,
      allowanceBytes: MANAGED_PLAN.heapAllowanceBytes,
      method:
        'main-isolate full-GC checkpoints every25 edits; excludes Worker heaps; finite retention sentinel',
    },
    ownerRss: {
      checkpoints: rss,
      firstPostWarmupMedianBytes: firstRss,
      finalMedianBytes: lastRss,
      differenceBytes: lastRss - firstRss,
      allowanceBytes: MANAGED_PLAN.rssAllowanceBytes,
      method:
        'owner-process RSS includes Worker heaps/native allocator retention; median windows edits25..125 and400..500; finite retention sentinel',
    },
    processResources: reloadObservationResources(observation),
    nativeShutdownMs: shutdown,
    externalHmrQualified: false,
    performanceEligible: false,
  })
}

export function acceptManagedDevelopmentReport(
  input: unknown,
  options: { allowRedactedRuntime?: boolean } = {}
) {
  const report = record(input, 'Missing managed development report')
  assert.equal(report['schema'], 1)
  assert.equal(report['profile'], MANAGED_PROFILE)
  assert.equal(report['passed'], true)
  if (options.allowRedactedRuntime === true)
    assert.ok(['1.4.4', 'VERSION_REDACTED'].includes(String(report['bun'])))
  else assert.equal(report['bun'], '1.4.4')
  assert.equal(report['observerTimeoutMs'], MANAGED_OBSERVER_MS)
  assert.equal(report['successfulReplacementPlan'], MANAGED_PLAN.replacements)
  assert.equal(report['launchPlan'], 1)
  assert.equal(report['restartLaunchPlan'], 1)
  assert.equal(report['performanceEligible'], false)
  assert.ok(['darwin-arm64', 'linux-x64', 'win32-x64'].includes(String(report['target'])))
  const source = record(report['sourceBefore'], 'Missing source identity')
  assert.equal(source['clean'], true)
  assert.equal(source['reason'], 'clean-checkout')
  checksum(source['commit'], 'Invalid immutable source commit', 40)
  assert.deepEqual(report['sourceAfter'], source)
  const sourceHashes = report['sourceHashes']
  assert.ok(Array.isArray(sourceHashes) && sourceHashes.length > 10 && sourceHashes.length <= 4096)
  const seen = new Set<string>()
  for (const value of sourceHashes) {
    const entry = record(value, 'Invalid source fingerprint')
    assert.ok(
      typeof entry['path'] === 'string' &&
        !entry['path'].startsWith('/') &&
        !entry['path'].includes('..') &&
        !seen.has(entry['path'])
    )
    seen.add(entry['path'])
    checksum(entry['sha256'], 'Invalid source fingerprint')
  }
  for (const required of [
    'scripts/qualify-managed-development.ts',
    'scripts/managed-restart-check.ts',
    'benchmarks/reload/managed-acceptance.ts',
    'benchmarks/reload/managed-restart-acceptance.ts',
    'benchmarks/reload/managed-observation.ts',
    'benchmarks/reload/prepared-file-metadata.ts',
    'examples/managed-desktop/main.ts',
    'examples/managed-desktop/client.ts',
    'examples/managed-desktop/evidence.ts',
    'examples/managed-desktop/restart.ts',
    'examples/managed-desktop/restart-client.ts',
    'examples/managed-desktop/restart-contract.ts',
    'examples/managed-desktop/backend/restart-service.ts',
    'packages/runtime/src/service-reload.ts',
    'packages/runtime/src/service-reload-runner.ts',
    'packages/runtime/src/managed-desktop.ts',
    'packages/cli/src/dev-host.ts',
    'packages/cli/src/dev-cache.ts',
  ])
    assert.ok(seen.has(required), `Missing required source fingerprint: ${required}`)
  assert.deepEqual(report['sourceHashesAfter'], sourceHashes)
  const native = record(
    report['nativeSource'],
    'Missing explicit prebuilt native source declaration'
  )
  checksum(native['declaredCommit'], 'Invalid native source commit', 40)
  checksum(native['tree'], 'Invalid native source tree', 40)
  assert.equal(
    native['provenance'],
    'explicit-caller-selected-build-source-with-identical-current-native-tree'
  )
  checksum(report['inputHostSha256'], 'Missing selected native host hash')
  const runtime = record(report['runtimeIdentity'], 'Missing actual exported CEF identity')
  assert.equal(runtime['event'], 'cef-binary-identity')
  assert.equal(runtime['cefVersion'], '156.0.7')
  assert.equal(runtime['chromiumVersion'], '156.0.8078.17')
  assert.equal(runtime['source'], 'exported-api')
  checksum(runtime['sha256'], 'Missing actual CEF binary hash')
  const cache = record(report['cache'], 'Missing prepared-host reuse evidence')
  checksum(cache['key'], 'Invalid prepared-host key')
  assert.equal(cache['assemblies'], 1)
  assert.equal(record(cache['cold'], 'Missing cold cache observation')['cacheHit'], false)
  assert.equal(record(cache['warm'], 'Missing warm cache observation')['cacheHit'], true)
  for (const stage of ['cold', 'warm']) {
    const item = record(cache[stage], 'Missing cache verification timing')
    finite(item['durationMs'], 'Invalid cache verification timing', 600000)
    integer(item['verifiedBytes'], 'Missing verified native byte count', 2 ** 40)
  }
  assert.equal(cache['warmNativeCopies'], 0)
  assert.equal(cache['warmNativeCompilations'], 0)
  for (const field of [
    'inputArtifactUnchanged',
    'preparedArtifactUnchanged',
    'preparedFileIdentityUnchanged',
    'launchPathEmpty',
  ])
    assert.equal(report[field], true, field)
  for (const field of ['inputArtifact', 'preparedArtifact']) {
    const artifact = record(report[field], 'Missing runtime file inventory')
    assert.equal(artifact['schema'], 1)
    assert.equal(artifact['metric'], 'logical-installed-file-bytes-no-symlink-traversal')
    const entries = artifact['entries']
    assert.ok(Array.isArray(entries) && entries.length > 5 && entries.length < 16384)
    let bytes = 0
    const paths = new Set<string>()
    for (const value of entries) {
      const entry = record(value, 'Invalid runtime inventory member')
      assert.ok(
        typeof entry['path'] === 'string' &&
          !entry['path'].startsWith('/') &&
          !entry['path'].split('/').includes('..') &&
          !paths.has(entry['path'])
      )
      paths.add(entry['path'])
      bytes += integer(entry['bytes'], 'Invalid runtime member size', 2 ** 40)
      if (entry['kind'] === 'file') checksum(entry['sha256'], 'Missing runtime member hash')
      else {
        assert.equal(entry['kind'], 'symlink')
        assert.equal(entry['sha256'], null)
        assert.equal(typeof entry['target'], 'string')
      }
    }
    assert.equal(artifact['bytes'], bytes)
    assert.deepEqual(
      report[field + 'After'],
      artifact,
      'Runtime inventory changed across ordinary edits'
    )
  }
  const prepared = record(report['preparedArtifact'], 'Missing prepared inventory')[
    'entries'
  ] as Record<string, unknown>[]
  const selected = record(report['inputArtifact'], 'Missing input inventory')['entries'] as Record<
    string,
    unknown
  >[]
  assert.ok(
    selected.some(
      (entry) => entry['kind'] === 'file' && entry['sha256'] === report['inputHostSha256']
    ),
    'Selected native host hash is absent from the selected inventory'
  )
  assert.ok(
    prepared.some((entry) => entry['kind'] === 'file' && entry['sha256'] === runtime['sha256']),
    'Exported CEF identity does not match prepared bytes'
  )
  const metadata = report['preparedFileMetadataBefore']
  assert.ok(
    Array.isArray(metadata) && metadata.length === prepared.length,
    'Incomplete prepared file metadata'
  )
  assert.deepEqual(
    metadata.map((value) => record(value, 'Invalid prepared file metadata')['path']),
    prepared.map((entry) => entry['path'])
  )
  for (const value of metadata) {
    const entry = record(value, 'Invalid prepared file metadata')
    for (const field of ['size', 'mtimeNs', 'ctimeNs'])
      assert.match(String(entry[field]), /^[0-9]{1,24}$/)
  }
  const bun = record(report['bundledBun'], 'Missing actual bundled Bun version observation')
  if (options.allowRedactedRuntime === true)
    assert.ok(['1.4.4', 'VERSION_REDACTED'].includes(String(bun['version'])))
  else assert.equal(bun['version'], '1.4.4')
  checksum(bun['sha256'], 'Missing bundled Bun hash')
  checksum(bun['observationSha256'], 'Missing bundled Bun observation hash')
  assert.equal(
    bun['observationContentSha256'],
    managedObservationContentSha256(bun['observation']),
    'Embedded bundled Bun observation differs from its retained digest'
  )
  assert.ok(
    prepared.some(
      (entry) =>
        entry['kind'] === 'file' &&
        entry['path'] === bun['path'] &&
        entry['sha256'] === bun['sha256']
    ),
    'Observed Bun does not match prepared bytes'
  )
  const bunObservation = validateCommandObservation(bun['observation'])
  assertCleanCommand(bunObservation)
  assert.deepEqual(bunObservation.stdoutTail, [
    options.allowRedactedRuntime === true && bun['version'] === 'VERSION_REDACTED'
      ? 'VERSION_REDACTED'
      : '1.4.4',
  ])
  const trials = report['trials']
  assert.ok(
    Array.isArray(trials) && trials.length === 1,
    'No native trial may be omitted or retried'
  )
  const trial = record(trials[0], 'Missing native trial')
  assert.equal(trial['index'], 0)
  assert.equal(trial['passed'], true)
  checksum(trial['observationSha256'], 'Missing raw observation fingerprint')
  assert.equal(
    trial['observationContentSha256'],
    managedObservationContentSha256(trial['observation']),
    'Embedded native observation differs from its retained digest'
  )
  const rows = trial['rowsText'],
    result = trial['resultText']
  assert.equal(typeof rows, 'string')
  assert.equal(typeof result, 'string')
  assert.equal(trial['rowsBytes'], Buffer.byteLength(String(rows)))
  assert.equal(trial['resultBytes'], Buffer.byteLength(String(result)))
  assert.equal(trial['rowsSha256'], hash(String(rows)))
  assert.equal(trial['resultSha256'], hash(String(result)))
  const accepted = acceptManagedDevelopmentWorkload(trial['observation'], rows, result)
  assert.deepEqual(trial['acceptance'], accepted, 'Stored acceptance differs from replay')
  assert.deepEqual(trial['processResources'], accepted.processResources)
  const completed = record(JSON.parse(String(result)), 'Missing completed soak result')
  const previousIdentities = record(
    record(completed['identities'], 'Missing soak identities')['before'],
    'Missing initial soak identities'
  ) as Record<string, string>
  const firstRenderer = parseRows(rows).find((row) => row['kind'] === 'renderer')!
  const previousRendererInstance = record(firstRenderer['renderer'], 'Missing initial renderer')[
    'instance'
  ] as string
  const restart = record(report['restart'], 'Missing separate controlled-restart launch')
  const restarted = acceptManagedRestartReport(restart, {
    previousIdentities,
    previousRendererInstance,
    configurationSha256: hash(MANAGED_RESTART_CONFIGURATION),
  })
  assert.notEqual(
    restart['observationContentSha256'],
    trial['observationContentSha256'],
    'The full restart reused the soak observation'
  )
  assert.equal(report['preparedHostPath'] !== undefined, true)
  const metadataAcceptance = acceptPreparedFileMetadata({
    before: metadata,
    after: report['preparedFileMetadataAfter'],
    hostPath: String(report['preparedHostPath']),
    target: String(report['target']),
    observations: [trial['observation'], restart['observation']],
  })
  assert.deepEqual(
    report['metadataAcceptance'],
    metadataAcceptance,
    'Stored file-identity qualification differs from replay'
  )
  return Object.freeze({ ...accepted, controlledRestart: restarted })
}

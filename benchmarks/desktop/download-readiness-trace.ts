/** Isolated Windows diagnostic. Only fixed labels and relative numeric timings leave here. */
import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

export const downloadTraceLimits = {
  durationMs: 15_000,
  bufferKiB: 8192,
  rawBytes: 64 * 1024 * 1024,
  clockBytes: 4096,
  events: 500_000,
  stackDepth: 256,
  threads: 1024,
  spans: 100_000,
  retainedSpansPerLabel: 8,
} as const

export function requireDisposableDownloadTrace(options: {
  readonly platform: string
  readonly arch: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly fixture: string
}): void {
  const { environment } = options
  if (
    options.platform !== 'win32' ||
    options.arch !== 'x64' ||
    options.fixture !== 'file-downloads' ||
    environment['GITHUB_ACTIONS'] !== 'true' ||
    environment['RUNNER_ENVIRONMENT'] !== 'github-hosted' ||
    environment['RUNNER_OS'] !== 'Windows' ||
    !/^[1-9][0-9]{0,19}$/.test(environment['GITHUB_RUN_ID'] ?? '')
  )
    throw new Error('Download tracing requires the disposable hosted Windows download fixture')
}

// These names/categories come from pinned Chromium 156.0.8078.17. Arguments,
// SQL text, filenames, URLs, source locations, metadata and native IDs are dropped.
const eventLabels = new Map<string, readonly [string, string]>([
  ['HistoryBackend::Init', ['history-backend-init', 'browser']],
  ['HistoryService::Init', ['history-service-init', 'browser']],
  ['ProfileImpl::DoFinalInit', ['profile-final-init', 'browser']],
  ['ProfileImpl::OnPrefsLoaded', ['profile-prefs-loaded', 'browser']],
  ['ChromeBrowserMainParts::CreateProfile', ['profile-create', 'startup']],
  ['BrowserMainLoop::CreateThreads', ['thread-pool-start', 'startup']],
  ['StartupTracingController::Start', ['trace-controller-start', 'startup']],
  ['Startup.StartupComplete', ['startup-complete', 'startup']],
  ['Database::Open', ['sql-open', 'sql']],
  ['Database::OpenInternal', ['sql-open-internal', 'sql']],
  ['Database::OpenInternal sqlite3_open_v2', ['sqlite-open', 'sql']],
  ['Database::OpenInMemory', ['sql-open-memory', 'sql']],
  ['Database::Execute', ['sql-execute', 'sql']],
  ['Database::ExecuteAndReturnErrorCode', ['sql-execute-direct', 'sql']],
  ['Database::ExecuteWithTimeout', ['sql-execute-with-timeout', 'sql']],
  ['Database::BeginTransaction', ['sql-begin', 'sql']],
  ['Database::CommitTransaction', ['sql-commit', 'sql']],
  ['Database::Statement', ['sql-statement', 'sql']],
  ['SyncParent', ['leveldb-sync-parent', 'leveldb']],
  ['WritableFile::Sync', ['leveldb-file-sync', 'leveldb']],
  ['ChromiumEnv::RewriteDB', ['leveldb-rewrite', 'leveldb']],
])
const taskFiles = [
  ['components/history/core/browser/history_backend_runner.cc', 'history-backend-task'],
  ['components/history/core/browser/history_service.cc', 'history-service-task'],
  ['components/leveldb_proto/internal/proto_database_impl.h', 'proto-db-task'],
  ['components/leveldb_proto/internal/proto_database_selector.cc', 'proto-selector-task'],
  ['components/leveldb_proto/internal/proto_leveldb_wrapper.cc', 'proto-leveldb-task'],
  ['components/leveldb_proto/internal/shared_proto_database.cc', 'shared-proto-db-task'],
  ['components/leveldb_proto/internal/shared_proto_database_provider.cc', 'shared-provider-task'],
  ['components/leveldb_proto/internal/shared_proto_database_provider.h', 'shared-provider-task'],
  ['components/leveldb_proto/public/proto_database_provider.cc', 'proto-provider-task'],
  ['components/download/internal/common/in_progress_download_manager.cc', 'in-progress-task'],
  ['content/browser/download/download_manager_impl.cc', 'download-manager-task'],
] as const

type RecordValue = Record<string, unknown>
interface Span {
  readonly label: string | null
  readonly thread: number | null
  readonly start: number
  readonly end: number
  readonly task: boolean
}
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined
}
function parsed(bytes: Uint8Array, limit: number): RecordValue {
  if (bytes.byteLength === 0 || bytes.byteLength > limit)
    throw new Error('Private trace input exceeds its byte bound')
  try {
    const result = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (result) return result
  } catch {
    // JSON parser diagnostics can contain input excerpts. Never propagate them.
  }
  throw new Error('Invalid private trace JSON')
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 2 ** 53
}
function categories(value: unknown): readonly string[] {
  return typeof value === 'string' && value.length < 256 ? value.split(',') : []
}
function taskLabel(args: unknown): string | null {
  // Legacy src_file and Perfetto task.posted_from nesting are both accepted.
  // Only exact allowlisted source suffixes select a fixed output label.
  const pending: [unknown, number][] = [[args, 0]]
  for (let index = 0; index < pending.length && index < 64; index++) {
    const [value, depth] = pending[index]!
    if (typeof value === 'string' && value.length < 4096) {
      const path = value.replaceAll('\\', '/')
      const match = taskFiles.find(([suffix]) => path === suffix || path.endsWith('/' + suffix))
      if (match) return match[1]
    } else if (depth < 4) {
      const object = record(value)
      if (object) {
        for (const child of Object.values(object).slice(0, 16)) pending.push([child, depth + 1])
      }
    }
  }
  return null
}
function flowKey(event: RecordValue): string | undefined {
  const id2 = record(event['id2'])
  const scope = id2 && Object.hasOwn(id2, 'local') ? 'local' : 'global'
  const id = id2?.[scope] ?? event['id']
  if ((typeof id === 'string' && id.length <= 128) || integer(id)) return `${scope}:${id}`
  return undefined
}

export function summarizeDownloadReadinessTrace(raw: Uint8Array, clockBytes: Uint8Array) {
  const clocks = parsed(clockBytes, downloadTraceLimits.clockBytes)
  if (
    Object.keys(clocks).sort().join(',') !==
      'beforeInitializeUs,contextInitializedUs,firstCallbackUs,firstDownloadUs,process,schema,switchesApplied' ||
    clocks['schema'] !== 1 ||
    clocks['switchesApplied'] !== true ||
    !integer(clocks['process']) ||
    clocks['process'] < 1
  )
    throw new Error('Invalid private trace clock receipt')
  for (const name of ['beforeInitializeUs', 'contextInitializedUs', 'firstDownloadUs']) {
    if (!integer(clocks[name]) || clocks[name] === 0)
      throw new Error('Missing private trace clock anchor')
  }
  const origin = clocks['firstDownloadUs'] as number
  const before = clocks['beforeInitializeUs'] as number
  const context = clocks['contextInitializedUs'] as number
  const callback = clocks['firstCallbackUs']
  if (
    context < before ||
    origin < context ||
    origin - before > 60_000_000 ||
    (callback !== null &&
      (!integer(callback) || callback < origin || callback - before > 60_000_000))
  )
    throw new Error('Inconsistent private trace clock anchors')
  const trace = parsed(raw, downloadTraceLimits.rawBytes)
  const events = trace['traceEvents']
  if (!Array.isArray(events) || events.length > downloadTraceLimits.events)
    throw new Error('Invalid bounded trace event list')
  const spans: Span[] = []
  const stacks = new Map<number, Omit<Span, 'end'>[]>()
  const posts = new Map<string, number | null>()
  const finishes: { key: string | undefined; thread: number; at: number }[] = []
  const arrivals = new Map<string, number | null>()
  const asyncEvents: {
    key: string
    phase: 'b' | 'e'
    at: number
    label: string | null
  }[] = []
  const asyncStacks = new Map<string, Omit<Span, 'end'>[]>()
  let unmatchedEnds = 0
  let unmatchedAsyncEnds = 0
  let unclassifiedTasks = 0
  let ignoredEvents = 0
  let unmatchedFlows = 0
  const inWindow = (time: number) => time >= before - 1_000_000 && time <= before + 60_000_000
  function add(span: Span) {
    if (span.end < span.start || !inWindow(span.start) || !inWindow(span.end))
      throw new Error('Trace timestamp does not match the native clock window')
    if (spans.length >= downloadTraceLimits.spans) throw new Error('Trace span bound exceeded')
    spans.push(span)
  }
  for (const value of events) {
    const event = record(value)
    if (!event || event['pid'] !== clocks['process'] || !integer(event['tid'])) {
      ignoredEvents++
      continue
    }
    const phase = event['ph']
    if (!['X', 'B', 'E', 'i', 'I', 's', 'f', 'b', 'e', 'n'].includes(String(phase))) continue
    const ts = event['ts']
    if (!timestamp(ts)) throw new Error('Invalid native trace timestamp')
    const thread = event['tid']
    const cats = categories(event['cat'])
    if (
      phase === 's' &&
      (event['name'] === 'ThreadPool_PostTask' || event['name'] === 'SequenceManager PostTask') &&
      cats.includes('toplevel.flow')
    ) {
      const key = flowKey(event)
      if (key) posts.set(key, posts.has(key) ? null : ts)
      continue
    }
    if (phase === 'f' && (cats.includes('toplevel') || cats.includes('toplevel.flow'))) {
      const key = flowKey(event)
      finishes.push({ key, thread, at: ts })
      continue
    }
    const fixed = typeof event['name'] === 'string' ? eventLabels.get(event['name']) : undefined
    const task =
      cats.includes('toplevel') &&
      (event['name'] === 'ThreadPool_RunTask' ||
        event['name'] === 'ThreadControllerImpl::RunTask' ||
        event['name'] === 'RunTask')
    const label =
      fixed && cats.includes(fixed[1]) ? fixed[0] : task ? taskLabel(event['args']) : null
    if (task && label === null) unclassifiedTasks++
    if (phase === 'b' || phase === 'e' || phase === 'n') {
      // Named Perfetto tracks (including SQL Statements) are exported as async
      // pairs. Their JSON tid can be synthetic; it does not identify the worker.
      const id = flowKey(event)
      const scope = event['scope'] ?? ''
      if (!id || typeof scope !== 'string' || scope.length > 128) {
        ignoredEvents++
        continue
      }
      if (phase === 'n') {
        if (label !== null) add({ label, thread: null, start: ts, end: ts, task: false })
      } else {
        asyncEvents.push({ key: JSON.stringify([cats, scope, id]), phase, at: ts, label })
      }
    } else if (phase === 'X') {
      const duration = event['dur']
      if ((label !== null || task) && timestamp(duration))
        add({ label, thread, start: ts, end: ts + duration, task })
      else if (label !== null || task) throw new Error('Invalid trace span duration')
    } else if (phase === 'B') {
      const stack = stacks.get(thread) ?? []
      if (
        stack.length >= downloadTraceLimits.stackDepth ||
        (!stacks.has(thread) && stacks.size >= downloadTraceLimits.threads)
      )
        throw new Error('Trace nesting bound exceeded')
      stack.push({ label, thread, start: ts, task })
      stacks.set(thread, stack)
    } else if (phase === 'E') {
      const start = stacks.get(thread)?.pop()
      if (start && (start.label !== null || start.task)) add({ ...start, end: ts })
      else if (!start) unmatchedEnds++
    } else if ((phase === 'i' || phase === 'I') && label !== null) {
      add({ label, thread, start: ts, end: ts, task: false })
    }
  }
  // Async records can be serialized in separate begin/end batches. Pair each
  // named track in timestamp order without treating its synthetic tid as a CPU
  // thread. Incomplete tracks stay explicit instead of becoming zero durations.
  for (const event of asyncEvents.sort(
    (a, b) => a.at - b.at || (a.phase === b.phase ? 0 : a.phase === 'e' ? -1 : 1)
  )) {
    const stack = asyncStacks.get(event.key) ?? []
    if (event.phase === 'b') {
      if (
        stack.length >= downloadTraceLimits.stackDepth ||
        (!asyncStacks.has(event.key) && asyncStacks.size >= downloadTraceLimits.threads)
      )
        throw new Error('Trace async nesting bound exceeded')
      stack.push({ label: event.label, thread: null, start: event.at, task: false })
      asyncStacks.set(event.key, stack)
    } else {
      const start = stack.pop()
      if (start && start.label !== null) add({ ...start, end: event.at })
      else if (!start) unmatchedAsyncEnds++
    }
  }
  // Trace packets from different threads need not be serialized in timestamp
  // order. Pair flows only after every post has been indexed. Ambiguous IDs or
  // multiple incoming flows at one instant remain unobserved.
  for (const finish of finishes) {
    const posted = finish.key === undefined ? undefined : posts.get(finish.key)
    if (posted !== undefined && posted !== null && posted <= finish.at) {
      const key = `${finish.thread}:${finish.at}`
      arrivals.set(key, arrivals.has(key) ? null : finish.at - posted)
    } else unmatchedFlows++
  }
  const tasks = spans.filter((span) => span.task)
  const fixed = spans.filter((span) => span.label !== null)
  const threads = new Map<number, number>()
  const threadAlias = (id: number) => {
    if (!threads.has(id)) threads.set(id, threads.size + 1)
    return threads.get(id)!
  }
  const relative = (time: number) => Math.round(time - origin)
  const duration = (span: Span) => Math.round(span.end - span.start)
  function queueWait(span: Span): number | null {
    if (span.thread === null) return null
    const task = span.task
      ? span
      : tasks
          .filter(
            (candidate) =>
              candidate.thread === span.thread &&
              candidate.start <= span.start &&
              candidate.end >= span.end
          )
          .sort((a, b) => duration(a) - duration(b))[0]
    if (!task) return null
    const wait = arrivals.get(`${task.thread}:${task.start}`)
    return wait === undefined || wait === null ? null : Math.round(wait)
  }
  const labels = [
    ...new Set(
      [...eventLabels.values()].map(([label]) => label).concat(taskFiles.map(([, label]) => label))
    ),
  ]
  const timings = labels.map((label) => {
    const matching = fixed.filter((span) => span.label === label)
    const longest = [...matching]
      .sort((a, b) => duration(b) - duration(a))
      .slice(0, downloadTraceLimits.retainedSpansPerLabel)
    return {
      label,
      count: matching.length,
      totalDurationUs: matching.reduce((total, span) => total + duration(span), 0),
      maximumDurationUs:
        matching.length === 0
          ? null
          : matching.reduce((max, span) => Math.max(max, duration(span)), 0),
      firstStartUs:
        matching.length === 0
          ? null
          : matching.reduce(
              (min, span) => Math.min(min, relative(span.start)),
              Number.POSITIVE_INFINITY
            ),
      lastEndUs:
        matching.length === 0
          ? null
          : matching.reduce(
              (max, span) => Math.max(max, relative(span.end)),
              Number.NEGATIVE_INFINITY
            ),
      longest: longest.map((span) => ({
        thread: span.thread === null ? null : threadAlias(span.thread),
        startUs: relative(span.start),
        durationUs: duration(span),
        enclosingTaskQueueWaitUs: queueWait(span),
      })),
    }
  })
  if (fixed.length === 0) throw new Error('No allowlisted native trace events were captured')
  return {
    schema: 1,
    kind: 'windows-download-readiness-trace-summary',
    diagnosticOnly: true,
    maintainedAcceptance: false,
    timingUnit: 'microseconds',
    origin: 'first-native-download-record',
    limits: downloadTraceLimits,
    rawSha256: createHash('sha256').update(raw).digest('hex'),
    rawBytes: raw.byteLength,
    parsedEvents: events.length,
    ignoredEvents,
    unclassifiedTasks,
    unmatchedEnds,
    unmatchedBegins: [...stacks.values()].reduce((total, stack) => total + stack.length, 0),
    unmatchedAsyncEnds,
    unmatchedAsyncBegins: [...asyncStacks.values()].reduce(
      (total, stack) => total + stack.length,
      0
    ),
    observedAsyncSpans: fixed.filter((span) => span.thread === null).length,
    unmatchedFlows,
    dataLossVerified: false,
    coverage: {
      historyBackendInitObserved: fixed.some((span) => span.label === 'history-backend-init'),
      nativeSpansBeforeContext: spans.some((span) => span.start < context),
      nativeSpansThroughFirstCallback:
        callback === null ? null : spans.some((span) => span.end >= (callback as number)),
    },
    clocksUs: {
      beforeInitialize: relative(before),
      contextInitialized: relative(context),
      firstDownload: 0,
      firstCallback: callback === null ? null : relative(callback as number),
    },
    timings,
    limitations: [
      'Instrumented disposable synthetic fixture; tracing can perturb scheduling.',
      'Only fixed event/task labels and relative numeric timings are retained; raw input is deleted.',
      'Nested durations overlap and must not be summed across labels.',
      'Async named-track spans have no execution-thread or enclosing task attribution.',
      'Missing events, incomplete scopes, or unmatched flows are unobserved rather than zero-duration work.',
      'Record-until-full and event loss can omit later events; loss has not been independently verified.',
      'History completion is not download-ID or in-progress-cache readiness.',
    ],
  }
}

async function boundedRead(path: string, limit: number): Promise<Uint8Array> {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > limit)
    throw new Error('Invalid private trace file')
  const file = await open(path, 'r')
  try {
    const data = Buffer.alloc(entry.size + 1)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== entry.size) throw new Error('Private trace file changed while reading')
    return data.subarray(0, offset)
  } finally {
    await file.close()
  }
}
export async function readDownloadReadinessTrace(directory: string) {
  let inputs: [Uint8Array, Uint8Array]
  try {
    inputs = await Promise.all([
      boundedRead(join(directory, 'trace.json'), downloadTraceLimits.rawBytes),
      boundedRead(join(directory, 'clocks.json'), downloadTraceLimits.clockBytes),
    ])
  } catch {
    // Filesystem errors include private absolute paths. Do not propagate them.
    throw new Error('Private trace files are unavailable or invalid')
  }
  const [raw, clocks] = inputs
  return summarizeDownloadReadinessTrace(raw, clocks)
}

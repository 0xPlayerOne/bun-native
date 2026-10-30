import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadTraceLimits,
  readDownloadReadinessTrace,
  requireDisposableDownloadTrace,
  summarizeDownloadReadinessTrace,
} from '../benchmarks/desktop/download-readiness-trace.ts'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const clocks = {
  schema: 1,
  switchesApplied: true,
  process: 42,
  beforeInitializeUs: 1_000_000,
  contextInitializedUs: 1_100_000,
  firstDownloadUs: 1_200_000,
  firstCallbackUs: 6_750_000,
}
const event = (fields: Record<string, unknown>) => ({ pid: 42, tid: 2, ...fields })
const complete = (name: string, cat: string, ts: number, dur: number) =>
  event({ ph: 'X', name, cat, ts, dur })
const trace = (events: readonly unknown[]) => bytes({ traceEvents: events })
const timing = (summary: ReturnType<typeof summarizeDownloadReadinessTrace>, label: string) =>
  summary.timings.find((item) => item.label === label)!

test('startup summary aligns history, direct SQL, and task queue time without exporting raw metadata', () => {
  const secret = 'PRIVATE SQL, URL, profile path, and metadata must not leave the parser'
  const raw = bytes({
    metadata: { commandLine: secret, profile: secret },
    traceEvents: [
      event({
        ph: 's',
        cat: 'toplevel.flow',
        name: 'ThreadPool_PostTask',
        ts: 1_010_000,
        id2: { local: '0xabc' },
      }),
      event({
        ph: 'f',
        cat: 'toplevel',
        name: 'ThreadPool_RunTask',
        ts: 1_049_999,
        id2: { local: '0xabc' },
      }),
      {
        ...complete('ThreadPool_RunTask', 'toplevel', 1_049_999, 5_700_001),
        args: {
          src_file: '../../components/history/core/browser/history_backend_runner.cc',
          src_func: secret,
        },
      },
      complete('HistoryBackend::Init', 'browser', 1_050_000, 5_700_000),
      {
        ...complete('Database::ExecuteAndReturnErrorCode', 'sql', 1_300_000, 5_000_000),
        args: { path: secret, query: secret },
      },
      { ...complete('HistoryBackend::Init', 'browser', 1_050_000, 7_000_000), pid: 43 },
      { ...complete(secret, 'browser', 1_100_000, 1), args: { secret } },
    ],
  })
  const summary = summarizeDownloadReadinessTrace(raw, bytes(clocks))
  expect(timing(summary, 'history-backend-init').longest).toEqual([
    { thread: 1, startUs: -150_000, durationUs: 5_700_000, enclosingTaskQueueWaitUs: 39_999 },
  ])
  expect(timing(summary, 'sql-execute-direct').maximumDurationUs).toBe(5_000_000)
  expect(timing(summary, 'history-backend-task').count).toBe(1)
  expect(summary.clocksUs).toEqual({
    beforeInitialize: -200_000,
    contextInitialized: -100_000,
    firstDownload: 0,
    firstCallback: 5_550_000,
  })
  expect(summary.coverage).toEqual({
    historyBackendInitObserved: true,
    nativeSpansBeforeContext: true,
    nativeSpansThroughFirstCallback: true,
  })
  expect(summary.maintainedAcceptance).toBe(false)
  expect(summary.dataLossVerified).toBe(false)
  const output = JSON.stringify(summary)
  for (const forbidden of [
    secret,
    '0xabc',
    'src_file',
    'commandLine',
    'history_backend_runner.cc',
    '"pid"',
  ])
    expect(output).not.toContain(forbidden)
})

test('nested begin/end events retain only matched fixed spans and flag incomplete scope', () => {
  const summary = summarizeDownloadReadinessTrace(
    trace([
      event({ ph: 'B', cat: 'browser', name: 'HistoryBackend::Init', ts: 1_150_000 }),
      event({ ph: 'B', cat: 'browser', name: 'private-ignored-event', ts: 1_160_000 }),
      event({ ph: 'E', ts: 1_170_000 }),
      event({ ph: 'B', cat: 'sql', name: 'Database::Execute', ts: 1_180_000 }),
      event({ ph: 'E', ts: 1_190_000 }),
      event({ ph: 'E', ts: 1_210_000 }),
      event({ ph: 'E', ts: 1_220_000 }),
      event({ ph: 'B', cat: 'sql', name: 'Database::Execute', ts: 1_230_000 }),
    ]),
    bytes({ ...clocks, firstCallbackUs: null })
  )
  expect(timing(summary, 'history-backend-init').totalDurationUs).toBe(60_000)
  expect(timing(summary, 'sql-execute').totalDurationUs).toBe(10_000)
  expect(timing(summary, 'sql-execute').count).toBe(1)
  expect(summary.unmatchedEnds).toBe(1)
  expect(summary.unmatchedBegins).toBe(1)
  expect(summary.coverage.nativeSpansThroughFirstCallback).toBeNull()
})

test('task flow association is independent of cross-thread serialization order', () => {
  const post = event({
    ph: 's',
    cat: 'toplevel.flow',
    name: 'ThreadPool_PostTask',
    ts: 1_010_000,
    id: 7,
  })
  const arrival = event({ ph: 'f', cat: 'toplevel', ts: 1_020_000, id: 7 })
  const task = complete('ThreadPool_RunTask', 'toplevel', 1_020_000, 500_000)
  const init = complete('HistoryBackend::Init', 'browser', 1_020_001, 499_999)
  for (const ordering of [
    [post, arrival, task, init],
    [arrival, task, init, post],
  ]) {
    const summary = summarizeDownloadReadinessTrace(trace(ordering), bytes(clocks))
    expect(timing(summary, 'history-backend-init').longest[0]?.enclosingTaskQueueWaitUs).toBe(
      10_000
    )
    expect(summary.unmatchedFlows).toBe(0)
  }
  const ambiguous = summarizeDownloadReadinessTrace(
    trace([post, { ...post, ts: 1_005_000 }, arrival, task, init]),
    bytes(clocks)
  )
  expect(timing(ambiguous, 'history-backend-init').longest[0]?.enclosingTaskQueueWaitUs).toBeNull()
})

test('UI sequence tasks retain posted cache notifications and delivery delay', () => {
  const summary = summarizeDownloadReadinessTrace(
    trace([
      event({
        ph: 's',
        cat: 'toplevel.flow',
        name: 'SequenceManager PostTask',
        ts: 1_010_000,
        id: 8,
      }),
      event({ ph: 'f', cat: 'toplevel', ts: 1_020_000, id: 8 }),
      {
        ...complete('ThreadControllerImpl::RunTask', 'toplevel', 1_020_000, 20),
        args: {
          task: {
            posted_from: {
              file_name: 'components/download/internal/common/in_progress_download_manager.cc',
            },
          },
        },
      },
    ]),
    bytes(clocks)
  )
  expect(timing(summary, 'in-progress-task').longest[0]?.enclosingTaskQueueWaitUs).toBe(10_000)
})

test('missing history and unmatched flow remain unobserved, never zero-time readiness', () => {
  const summary = summarizeDownloadReadinessTrace(
    trace([
      complete('Database::Open', 'sql', 1_300_000, 123),
      event({ ph: 'f', cat: 'toplevel', ts: 1_300_000, id: 'unknown' }),
      event({ ph: 'i', cat: 'startup', name: 'Startup.StartupComplete', ts: 1_400_000 }),
      { ...complete('HistoryBackend::Init', 'not-browser', 1_200_000, 1) },
    ]),
    bytes(clocks)
  )
  expect(summary.coverage.historyBackendInitObserved).toBe(false)
  expect(timing(summary, 'history-backend-init')).toEqual({
    label: 'history-backend-init',
    count: 0,
    totalDurationUs: 0,
    maximumDurationUs: null,
    firstStartUs: null,
    lastEndUs: null,
    longest: [],
  })
  expect(summary.unmatchedFlows).toBe(1)
  expect(timing(summary, 'sql-open').longest[0]?.enclosingTaskQueueWaitUs).toBeNull()
})

test('SQL named-track async pairs retain durations without inventing execution threads', () => {
  const statement = (ph: string, ts: number, id: string) =>
    event({
      ph,
      ts,
      name: 'Database::Statement',
      cat: 'sql',
      id2: { local: id },
    })
  const summary = summarizeDownloadReadinessTrace(
    trace([
      statement('e', 1_400_000, 'private-id'),
      statement('b', 1_300_000, 'private-id'),
      statement('b', 1_300_010, 'other-private-id'),
      statement('e', 1_300_020, 'other-private-id'),
      statement('b', 1_500_000, 'unfinished'),
      statement('e', 1_600_000, 'unstarted'),
      statement('n', 1_700_000, 'instant'),
      statement('b', 1_800_000, 'adjacent'),
      statement('b', 1_800_020, 'adjacent'),
      statement('e', 1_800_020, 'adjacent'),
      statement('e', 1_800_030, 'adjacent'),
    ]),
    bytes(clocks)
  )
  const sql = timing(summary, 'sql-statement')
  expect(sql.count).toBe(5)
  expect(sql.totalDurationUs).toBe(100_040)
  expect(sql.longest.map((span) => span.durationUs)).toEqual([100_000, 20, 10, 10, 0])
  expect(sql.longest[0]).toEqual({
    thread: null,
    startUs: 100_000,
    durationUs: 100_000,
    enclosingTaskQueueWaitUs: null,
  })
  expect(summary.observedAsyncSpans).toBe(5)
  expect(summary.unmatchedAsyncBegins).toBe(1)
  expect(summary.unmatchedAsyncEnds).toBe(1)
  expect(JSON.stringify(summary)).not.toContain('private-id')
})

test('summary rejects mismatched clocks, unbounded input, invalid durations, and parser excerpts', () => {
  const valid = trace([complete('HistoryBackend::Init', 'browser', 1_200_000, 1)])
  for (const change of [
    { schema: 2 },
    { switchesApplied: false },
    { process: -1 },
    { firstDownloadUs: null },
    { contextInitializedUs: 1_300_000 },
    { firstCallbackUs: 1_199_999 },
    { secret: 'not allowed' },
  ])
    expect(() => summarizeDownloadReadinessTrace(valid, bytes({ ...clocks, ...change }))).toThrow()
  expect(() =>
    summarizeDownloadReadinessTrace(valid, new Uint8Array(downloadTraceLimits.clockBytes + 1))
  ).toThrow('byte bound')
  expect(() =>
    summarizeDownloadReadinessTrace(
      trace(Array(downloadTraceLimits.events + 1).fill(null)),
      bytes(clocks)
    )
  ).toThrow('event list')
  expect(() =>
    summarizeDownloadReadinessTrace(
      trace([complete('HistoryBackend::Init', 'browser', 61_000_001, 1)]),
      bytes(clocks)
    )
  ).toThrow('clock window')
  expect(() =>
    summarizeDownloadReadinessTrace(
      trace([complete('HistoryBackend::Init', 'browser', 1_200_000, -1)]),
      bytes(clocks)
    )
  ).toThrow('duration')
  expect(() =>
    summarizeDownloadReadinessTrace(new TextEncoder().encode('{"secret":"PRIVATE"'), bytes(clocks))
  ).toThrow('Invalid private trace JSON')
})

test('capture precondition requires the synthetic fixture on a disposable Windows x64 runner', () => {
  const options = {
    platform: 'win32',
    arch: 'x64',
    fixture: 'file-downloads',
    environment: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
      GITHUB_RUN_ID: '42',
    },
  }
  expect(() => requireDisposableDownloadTrace(options)).not.toThrow()
  for (const change of [
    { platform: 'linux' },
    { arch: 'arm64' },
    { fixture: 'desktop-services' },
    { environment: { ...options.environment, RUNNER_ENVIRONMENT: 'self-hosted' } },
    { environment: { ...options.environment, GITHUB_RUN_ID: '' } },
  ])
    expect(() => requireDisposableDownloadTrace({ ...options, ...change })).toThrow()
})

test('private trace reader accepts only the fixed bounded files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-trace-parser-'))
  try {
    await writeFile(
      join(directory, 'trace.json'),
      trace([complete('HistoryBackend::Init', 'browser', 1_200_000, 1)])
    )
    await writeFile(join(directory, 'clocks.json'), bytes(clocks))
    expect((await readDownloadReadinessTrace(directory)).coverage.historyBackendInitObserved).toBe(
      true
    )
    await writeFile(
      join(directory, 'clocks.json'),
      new Uint8Array(downloadTraceLimits.clockBytes + 1)
    )
    await expect(readDownloadReadinessTrace(directory)).rejects.toThrow(
      'Private trace files are unavailable or invalid'
    )
    await rm(join(directory, 'trace.json'))
    const message = await readDownloadReadinessTrace(directory).catch((error: unknown) =>
      String(error)
    )
    expect(message).toBe('Error: Private trace files are unavailable or invalid')
    expect(message).not.toContain(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ownedChild } from '../benchmarks/lib/owned-child.ts'
import { createHash } from 'node:crypto'
import {
  acceptReloadProbe,
  acceptReloadMatrix,
  reloadProbeSummary,
  reloadSourcePaths,
  reloadObservationResources,
} from '../benchmarks/reload/acceptance.ts'
import {
  reloadCandidates,
  reloadMemoryScope,
  type ReloadCandidate,
} from '../benchmarks/reload/fixtures.ts'

function sample(mode: ReloadCandidate, count = 2): Record<string, unknown> {
  return {
    schema: 1,
    profile: 'reload-mechanisms-v1',
    mode,
    bun: '1.4.3',
    platform: 'linux',
    arch: 'x64',
    complete: true,
    hang: false,
    samples: count,
    resourceScope: 'synthetic-loopback-listener-and-timer-not-native-CEF-or-PTY',
    memoryScope: reloadMemoryScope(mode),
    heapAfterInitialGcBytes: 100,
    heapAfterFinalGcBytes: 110,
    trials: Array.from({ length: count }, (_, iteration) => ({
      iteration,
      expectedRevision: iteration,
      revision: mode === 'import' ? 0 : iteration,
      moduleInstance: mode === 'import' ? iteration + 1 : 1,
      globalInstance: mode === 'graph' ? iteration + 1 : 1,
      freshDependency: mode !== 'import' || iteration === 0,
      freshModuleState: mode !== 'import' || iteration === 0,
      passed: true,
      stableOwnerSurvived: true,
      timerStopped: mode === 'graph' || mode === 'import' ? true : null,
      cleanupEvidence:
        mode === 'worker'
          ? 'worker-exit-and-port-rebind'
          : mode === 'process'
            ? 'child-reaped-and-port-rebind'
            : 'timer-stable-and-port-rebind',
      listenerRebindAttempts: 1,
      loadMs: 1,
      disposeRequestMs: 1,
      rssBytes: 200,
      heapUsedBytes: 100,
    })),
    failures: ['syntax', 'missing', 'initialization', 'pending'].map((name) => ({
      name,
      outcome: name === 'pending' ? 'bounded-pending' : 'rejected',
      stableOwnerSurvived: true,
      incompleteImportPromise: name === 'pending' && (mode === 'graph' || mode === 'import'),
    })),
    ...(mode === 'graph'
      ? {
          graphBoundary: {
            externalListenerCallsAfterDisposal: 1,
            queuedMicrotasksAfterDisposal: 1,
            pendingSettledAfter30Ms: false,
            unmanagedFdSurvived: true,
            hostContextResourceSurvived: true,
            graphListenerRebindAttempts: 1,
          },
          graphAsyncErrorKind: 'uncaughtException',
        }
      : {}),
  }
}

test('synthetic validator fixtures distinguish observed replacements from stale imports', () => {
  for (const mode of reloadCandidates) {
    const result = acceptReloadProbe(sample(mode), mode, 2)
    expect(result.outcome).toBe(
      mode === 'import' ? 'rejected-stale-module-or-dependency' : 'cooperative-replacement-observed'
    )
  }
})

test('validator rejects missing generations, forged freshness and absent cleanup evidence', () => {
  const mutations: [string, (v: Record<string, unknown>) => void][] = [
    ['missing trial', (v) => (v['trials'] as unknown[]).pop()],
    [
      'wrong generation',
      (v) => {
        ;(v['trials'] as Record<string, unknown>[])[1]!['iteration'] = 0
      },
    ],
    [
      'forged freshness',
      (v) => {
        ;(v['trials'] as Record<string, unknown>[])[1]!['freshDependency'] = false
      },
    ],
    [
      'unclean',
      (v) => {
        ;(v['trials'] as Record<string, unknown>[])[1]!['passed'] = false
      },
    ],
    [
      'lost stable owner',
      (v) => {
        ;(v['trials'] as Record<string, unknown>[])[1]!['stableOwnerSurvived'] = false
      },
    ],
    [
      'missing port evidence',
      (v) => {
        ;(v['trials'] as Record<string, unknown>[])[1]!['listenerRebindAttempts'] = 0
      },
    ],
    [
      'still ticking',
      (v) => {
        ;(v['trials'] as Record<string, unknown>[])[1]!['timerStopped'] = false
      },
    ],
    [
      'nan timing',
      (v) => {
        ;(v['trials'] as Record<string, unknown>[])[1]!['loadMs'] = NaN
      },
    ],
    ['omitted failure', (v) => (v['failures'] as unknown[]).pop()],
    [
      'failure hidden',
      (v) => {
        ;(v['failures'] as Record<string, unknown>[])[0]!['outcome'] = 'passed'
      },
    ],
    [
      'wrong runtime',
      (v) => {
        v['bun'] = 'unqualified'
      },
    ],
    [
      'graph cleanup claim',
      (v) => {
        ;(v['graphBoundary'] as Record<string, unknown>)['pendingSettledAfter30Ms'] = true
      },
    ],
  ]
  for (const [name, mutate] of mutations) {
    const value = sample('graph')
    mutate(value)
    expect(() => acceptReloadProbe(value, 'graph', 2), name).toThrow()
  }
})

test('unknown or malformed reports cannot become a qualified reload profile', () => {
  for (const input of [null, [], {}, 'report', sample('process', 1)])
    expect(() => acceptReloadProbe(input, 'graph', 2)).toThrow()
})

test('synchronous-loop acceptance requires actual entry, owner survival and released listener', () => {
  const value = {
    ...sample('worker'),
    hang: true,
    trials: [],
    failures: [],
    hangResult: {
      loopEntryObserved: true,
      ownedGenerationStopped: true,
      stableOwnerSurvived: true,
      listenerRebindAttempts: 1,
    },
  }
  expect(acceptReloadProbe(value, 'worker', 2, true).outcome).toBe('isolated-loop-recovered')
  value.hangResult.loopEntryObserved = false
  expect(() => acceptReloadProbe(value, 'worker', 2, true)).toThrow()
})

for (const mode of reloadCandidates)
  test(`real ${mode} fixture completes bounded smoke and retains its limitations`, async () => {
    const work = await mkdtemp(join(tmpdir(), 'bunly-reload-test-'))
    const child = ownedChild(
      [process.execPath, resolve('benchmarks/reload/driver.ts'), mode, work, '1'],
      process.cwd()
    )
    try {
      const complete = await child.wait((r) => r['event'] === 'reload-probe-complete', 0, 12000)
      expect(complete['complete']).toBe(true)
      const exited = await child.wait((r) => r['event'] === 'exit', 0, 3000)
      expect(exited['code']).toBe(0)
      const result = JSON.parse(await readFile(join(work, 'result.json'), 'utf8'))
      expect(acceptReloadProbe(result, mode, 1).samples).toBe(1)
    } finally {
      await child.close()
      await rm(work, { recursive: true, maxRetries: 5, retryDelay: 25 })
    }
  }, 20000)

test('qualification CLI rejects extra arguments before creating any report', async () => {
  const child = ownedChild(
    [process.execPath, resolve('scripts/qualify-reload-mechanisms.ts'), '--overwrite'],
    process.cwd()
  )
  try {
    expect((await child.wait((r) => r['event'] === 'exit', 0, 3000))['code']).not.toBe(0)
  } finally {
    await child.close()
  }
})

function matrix(): Record<string, unknown> {
  return {
    schema: 1,
    profile: 'reload-mechanisms-matrix-v1',
    passed: true,
    bun: '1.4.3',
    samples: 20,
    selection: 'not-a-production-loader-selection',
    target: 'linux-x64',
    sourceBefore: { commit: 'a'.repeat(40), clean: true, reason: 'clean-checkout' },
    sourceAfter: { commit: 'a'.repeat(40), clean: true, reason: 'clean-checkout' },
    sourceHashes: reloadSourcePaths.map((path) => ({ path, sha256: 'b'.repeat(64) })),
    sourceHashesAfter: reloadSourcePaths.map((path) => ({ path, sha256: 'b'.repeat(64) })),
    cases: [false, true].flatMap((hang) =>
      reloadCandidates.map((mode) => {
        const forced = hang && (mode === 'graph' || mode === 'import')
        const result = hang
          ? {
              ...sample(mode, 20),
              hang: true,
              trials: [],
              failures: [],
              hangResult: {
                loopEntryObserved: true,
                ownedGenerationStopped: true,
                stableOwnerSurvived: true,
                listenerRebindAttempts: 1,
              },
            }
          : sample(mode, 20)
        return {
          name: `${mode}-${hang ? 'synchronous-loop' : 'repeated'}`,
          mode,
          hang,
          passed: true,
          observation: {
            sha256: 'c'.repeat(64),
            bytes: 1000,
            elapsedMs: 2100,
            peakTreeRssBytes: 200,
            peakTreeThreads: 2,
            cancelled: false,
            outputOverflow: false,
            observerFailure: null,
            orphanCount: 0,
            survivorCount: 0,
            timedOut: forced,
            exitCode: forced ? -9 : 0,
            environment: {
              os: 'Linux',
              release: '6.8',
              arch: 'x86_64',
              python: '3.11',
              psutil: '7.0.0',
              runClass: 'local-smoke',
            },
            resourceSamples: [
              { elapsedMs: 10, rssBytes: 200, threads: 2, processes: 1, descriptors: 4 },
            ],
          },
          ...(forced
            ? {
                outcome: 'owner-process-unresponsive-forced-restart-required',
                expectedApplicationFailure: true,
                loopEntryReceipt: { event: 'loop-entered', mode, stableListenerCreated: true },
              }
            : {
                result,
                resultSha256: createHash('sha256')
                  .update(JSON.stringify(result, null, 2) + '\n')
                  .digest('hex'),
                acceptance: acceptReloadProbe(result, mode, 20, hang),
                ...(!hang ? { summary: reloadProbeSummary(result) } : {}),
              }),
        }
      })
    ),
  }
}

test('complete matrix preserves rejected mechanisms and expected owner failures separately', () => {
  const outcomes = acceptReloadMatrix(matrix())
  expect(outcomes.length).toBe(8)
  expect(outcomes[0]!.outcome).toBe('rejected-stale-module-or-dependency')
  expect(outcomes[4]!.outcome).toBe('owner-process-unresponsive-forced-restart-required')
  expect(outcomes[6]!.outcome).toBe('isolated-loop-recovered')
})

test('matrix rejects altered results, summaries, observer failures and missing provenance', () => {
  const mutations: ((report: Record<string, unknown>, rows: Record<string, unknown>[]) => void)[] =
    [
      (r) => {
        r['sourceAfter'] = { commit: 'd'.repeat(40), clean: true, reason: 'clean-checkout' }
      },
      (r) => {
        ;(r['sourceHashes'] as unknown[]).pop()
      },
      (_r, rows) => {
        rows.pop()
      },
      (_r, rows) => {
        rows[0]!['name'] = rows[1]!['name']
      },
      (_r, rows) => {
        rows[0]!['resultSha256'] = '0'.repeat(64)
      },
      (_r, rows) => {
        ;(rows[0]!['summary'] as Record<string, unknown>)['loadMs'] = {}
      },
      (_r, rows) => {
        ;(rows[0]!['observation'] as Record<string, unknown>)['observerFailure'] = 'read-failed'
      },
      (_r, rows) => {
        ;(rows[0]!['observation'] as Record<string, unknown>)['survivorCount'] = 1
      },
      (_r, rows) => {
        ;(rows[0]!['observation'] as Record<string, unknown>)['resourceSamples'] = []
      },
      (_r, rows) => {
        ;(rows[0]!['observation'] as Record<string, unknown>)['peakTreeRssBytes'] = 0
      },
      (_r, rows) => {
        ;(rows[4]!['observation'] as Record<string, unknown>)['timedOut'] = false
      },
      (_r, rows) => {
        rows[4]!['loopEntryReceipt'] = undefined
      },
      (r) => {
        r['failureType'] = 'retained-failure'
      },
    ]
  for (const mutate of mutations) {
    const report = matrix()
    mutate(report, report['cases'] as Record<string, unknown>[])
    expect(() => acceptReloadMatrix(report)).toThrow()
  }
})

test('resource projection never publishes process identities and does not invent missing descriptor counts', () => {
  const samples = reloadObservationResources({
    samples: [
      {
        elapsedMs: 1,
        rssBytes: 20,
        threads: 2,
        processes: [
          { pid: 42, creationTime: 123, descriptors: 5 },
          { pid: 43, descriptors: 2 },
        ],
      },
      { elapsedMs: 2, rssBytes: 10, threads: 1, processes: [{ pid: 42, descriptors: null }] },
      { elapsedMs: 3, rssBytes: 0, threads: 0, processes: [] },
    ],
  })
  expect(samples).toEqual([
    { elapsedMs: 1, rssBytes: 20, threads: 2, processes: 2, descriptors: 7 },
    { elapsedMs: 2, rssBytes: 10, threads: 1, processes: 1, descriptors: null },
    { elapsedMs: 3, rssBytes: 0, threads: 0, processes: 0, descriptors: null },
  ])
  expect(JSON.stringify(samples).includes('pid')).toBe(false)
  expect(() => reloadObservationResources({ samples: [] })).toThrow()
})

for (const mode of ['worker', 'process'] as const)
  test(`real ${mode} loop stops without replacing the stable synthetic owner`, async () => {
    const work = await mkdtemp(join(tmpdir(), 'bunly-reload-loop-test-'))
    const child = ownedChild(
      [process.execPath, resolve('benchmarks/reload/driver.ts'), mode, work, '1', 'hang'],
      process.cwd()
    )
    try {
      const complete = await child.wait((r) => r['event'] === 'reload-probe-complete', 0, 12000)
      expect(complete['complete']).toBe(true)
      expect((await child.wait((r) => r['event'] === 'exit', 0, 3000))['code']).toBe(0)
      const result = JSON.parse(await readFile(join(work, 'result.json'), 'utf8'))
      expect(acceptReloadProbe(result, mode, 1, true).outcome).toBe('isolated-loop-recovered')
    } finally {
      await child.close()
      await rm(work, { recursive: true, maxRetries: 5, retryDelay: 25 })
    }
  }, 20000)

test('retained local matrix remains byte-bound with failed mechanisms preserved', async () => {
  const bytes = await readFile(resolve('evidence/m6-reload-local.json'))
  expect(bytes.length).toBe(115783)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '7dc2131c66de06262c1a8cb2ae99c460b2d6c5d043e61ff88de79a0543f0e78e'
  )
  const report = JSON.parse(bytes.toString())
  expect(report.sourceBefore.commit).toBe('6e4fd3b713a97dc9a5facf66ca95ba3fc7e309ff')
  const outcomes = acceptReloadMatrix(report)
  expect(outcomes[0]!.outcome).toBe('rejected-stale-module-or-dependency')
  expect(outcomes[4]!.outcome).toBe('owner-process-unresponsive-forced-restart-required')
  expect(outcomes[5]!.outcome).toBe('owner-process-unresponsive-forced-restart-required')
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { quantile } from '../lib/statistics.ts'
import { reloadCandidates, reloadMemoryScope, type ReloadCandidate } from './fixtures.ts'
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function finite(value: unknown, maximum: number) {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum)
}
export function acceptReloadProbe(
  input: unknown,
  expectedMode: ReloadCandidate,
  samples: number,
  hang = false,
  options: { allowRedactedRuntime?: boolean } = {}
) {
  assert.ok(reloadCandidates.includes(expectedMode))
  assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100)
  const value = object(input)
  assert.equal(value['schema'], 1)
  assert.equal(value['profile'], 'reload-mechanisms-v1')
  assert.equal(value['mode'], expectedMode)
  if (options.allowRedactedRuntime === true)
    assert.ok(['1.4.4', 'VERSION_REDACTED'].includes(String(value['bun'])))
  else assert.equal(value['bun'], '1.4.4')
  assert.equal(value['complete'], true)
  assert.equal(value['failureType'], undefined)
  assert.equal(value['hang'], hang)
  assert.equal(value['samples'], samples)
  assert.equal(
    value['resourceScope'],
    'synthetic-loopback-listener-and-timer-not-native-CEF-or-PTY'
  )
  assert.equal(value['memoryScope'], reloadMemoryScope(expectedMode))
  assert.ok(['darwin', 'linux', 'win32'].includes(String(value['platform'])))
  assert.ok(['arm64', 'x64'].includes(String(value['arch'])))
  finite(value['heapAfterInitialGcBytes'], 2 ** 48)
  finite(value['heapAfterFinalGcBytes'], 2 ** 48)
  assert.ok(Array.isArray(value['trials']) && Array.isArray(value['failures']))
  if (hang) {
    assert.ok(expectedMode === 'worker' || expectedMode === 'process')
    assert.equal(value['trials'].length, 0)
    assert.equal(value['failures'].length, 0)
    const result = object(value['hangResult'])
    assert.equal(result['loopEntryObserved'], true)
    assert.equal(result['ownedGenerationStopped'], true)
    assert.equal(result['stableOwnerSurvived'], true)
    assert.ok(
      Number.isSafeInteger(result['listenerRebindAttempts']) &&
        Number(result['listenerRebindAttempts']) >= 1 &&
        Number(result['listenerRebindAttempts']) <= 40
    )
    return { candidate: expectedMode, outcome: 'isolated-loop-recovered' as const }
  }
  assert.equal(value['trials'].length, samples)
  let fresh = 0
  for (const [index, inputRow] of value['trials'].entries()) {
    const row = object(inputRow)
    assert.equal(row['iteration'], index)
    assert.equal(row['expectedRevision'], index)
    assert.ok(
      Number.isSafeInteger(row['revision']) &&
        Number(row['revision']) >= 0 &&
        Number(row['revision']) < samples
    )
    assert.ok(
      Number.isSafeInteger(row['moduleInstance']) &&
        Number(row['moduleInstance']) >= 1 &&
        Number(row['moduleInstance']) <= samples
    )
    assert.ok(
      Number.isSafeInteger(row['globalInstance']) &&
        Number(row['globalInstance']) >= 1 &&
        Number(row['globalInstance']) <= samples
    )
    assert.equal(row['freshDependency'], row['revision'] === index)
    assert.equal(row['freshModuleState'], row['moduleInstance'] === 1)
    if (row['freshDependency'] && row['freshModuleState']) fresh++
    assert.equal(row['passed'], true)
    assert.equal(row['stableOwnerSurvived'], true)
    const local = expectedMode === 'import' || expectedMode === 'graph'
    assert.equal(row['timerStopped'], local ? true : null)
    assert.equal(
      row['cleanupEvidence'],
      expectedMode === 'worker'
        ? 'worker-exit-and-port-rebind'
        : expectedMode === 'process'
          ? 'child-reaped-and-port-rebind'
          : 'timer-stable-and-port-rebind'
    )
    assert.ok(
      Number.isSafeInteger(row['listenerRebindAttempts']) &&
        Number(row['listenerRebindAttempts']) >= 1 &&
        Number(row['listenerRebindAttempts']) <= 40
    )
    for (const metric of ['loadMs', 'disposeRequestMs']) finite(row[metric], 60000)
    for (const metric of ['rssBytes', 'heapUsedBytes']) finite(row[metric], 2 ** 48)
  }
  assert.equal(value['failures'].length, 4)
  for (const [index, name] of ['syntax', 'missing', 'initialization', 'pending'].entries()) {
    const row = object(value['failures'][index])
    assert.equal(row['name'], name)
    assert.equal(row['outcome'], name === 'pending' ? 'bounded-pending' : 'rejected')
    assert.equal(row['stableOwnerSurvived'], true)
    assert.equal(
      row['incompleteImportPromise'],
      name === 'pending' && (expectedMode === 'graph' || expectedMode === 'import')
    )
  }
  if (expectedMode === 'graph') {
    const boundary = object(value['graphBoundary'])
    assert.equal(boundary['externalListenerCallsAfterDisposal'], 1)
    assert.equal(boundary['queuedMicrotasksAfterDisposal'], 1)
    assert.equal(boundary['pendingSettledAfter30Ms'], false)
    assert.equal(boundary['unmanagedFdSurvived'], true)
    assert.equal(boundary['hostContextResourceSurvived'], true)
    assert.ok(
      Number.isSafeInteger(boundary['graphListenerRebindAttempts']) &&
        Number(boundary['graphListenerRebindAttempts']) >= 1 &&
        Number(boundary['graphListenerRebindAttempts']) <= 40
    )
    assert.equal(value['graphAsyncErrorKind'], 'uncaughtException')
  }
  return {
    candidate: expectedMode,
    outcome:
      fresh === samples
        ? ('cooperative-replacement-observed' as const)
        : ('rejected-stale-module-or-dependency' as const),
    freshGenerations: fresh,
    samples,
  }
}

export const reloadSourcePaths = [
  'benchmarks/reload/fixtures.ts',
  'benchmarks/reload/isolated.ts',
  'benchmarks/reload/candidate.ts',
  'benchmarks/reload/driver.ts',
  'benchmarks/reload/acceptance.ts',
  'scripts/qualify-reload-mechanisms.ts',
  'scripts/verify-reload-qualification.ts',
  'benchmarks/lib/owned-child.ts',
  'benchmarks/lib/observed-command.ts',
  'scripts/observe-process.py',
  'benchmarks/lib/statistics.ts',
  'package.json',
  'bun.lock',
] as const
export function acceptReloadMatrix(
  input: unknown,
  options: { allowRedactedRuntime?: boolean } = {}
) {
  const report = object(input)
  assert.equal(report['schema'], 1)
  assert.equal(report['profile'], 'reload-mechanisms-matrix-v1')
  assert.equal(report['passed'], true)
  assert.equal(report['failureType'], undefined)
  if (options.allowRedactedRuntime === true)
    assert.ok(['1.4.4', 'VERSION_REDACTED'].includes(String(report['bun'])))
  else assert.equal(report['bun'], '1.4.4')
  assert.equal(report['samples'], 20)
  assert.equal(report['selection'], 'not-a-production-loader-selection')
  const source = object(report['sourceBefore'])
  assert.equal(source['clean'], true)
  assert.equal(source['reason'], 'clean-checkout')
  assert.match(String(source['commit']), /^[a-f0-9]{40}$/)
  assert.deepEqual(report['sourceAfter'], source)
  const hashes = report['sourceHashes']
  assert.ok(Array.isArray(hashes))
  assert.equal(hashes.length, reloadSourcePaths.length)
  assert.deepEqual(
    hashes.map((x) => object(x)['path']),
    [...reloadSourcePaths]
  )
  for (const row of hashes) assert.match(String(object(row)['sha256']), /^[a-f0-9]{64}$/)
  assert.deepEqual(report['sourceHashesAfter'], hashes)
  assert.ok(
    ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'].includes(
      String(report['target'])
    )
  )
  const rows = report['cases']
  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, 8)
  const outcomes = []
  for (const [index, inputRow] of rows.entries()) {
    const row = object(inputRow),
      mode = reloadCandidates[index % 4]!,
      hang = index >= 4
    assert.equal(row['name'], `${mode}-${hang ? 'synchronous-loop' : 'repeated'}`)
    assert.equal(row['mode'], mode)
    assert.equal(row['hang'], hang)
    assert.equal(row['passed'], true)
    const observation = object(row['observation'])
    assert.match(String(observation['sha256']), /^[a-f0-9]{64}$/)
    finite(observation['bytes'], 64 * 1024 * 1024)
    for (const metric of ['elapsedMs', 'peakTreeRssBytes', 'peakTreeThreads'])
      finite(observation[metric], 2 ** 48)
    assert.equal(observation['observerFailure'], null)
    const environment = object(observation['environment'])
    assert.ok(['Darwin', 'Linux', 'Windows'].includes(String(environment['os'])))
    assert.ok(['local-smoke', 'ci-smoke'].includes(String(environment['runClass'])))
    for (const key of ['release', 'arch', 'python', 'psutil']) {
      assert.equal(typeof environment[key], 'string')
      assert.ok(String(environment[key]).length >= 1 && String(environment[key]).length <= 128)
    }
    const resources = observation['resourceSamples']
    assert.ok(Array.isArray(resources) && resources.length >= 1 && resources.length <= 4000)
    let previous = -1
    for (const inputSample of resources) {
      const sample = object(inputSample)
      assert.deepEqual(Object.keys(sample).sort(), [
        'descriptors',
        'elapsedMs',
        'processes',
        'rssBytes',
        'threads',
      ])
      finite(sample['elapsedMs'], Number(observation['elapsedMs']))
      assert.ok(Number(sample['elapsedMs']) >= previous)
      previous = Number(sample['elapsedMs'])
      for (const metric of ['rssBytes', 'threads', 'processes']) {
        assert.ok(Number.isSafeInteger(sample[metric]))
        finite(sample[metric], 2 ** 48)
      }
      if (sample['descriptors'] !== null) {
        assert.ok(Number.isSafeInteger(sample['descriptors']))
        finite(sample['descriptors'], 2 ** 48)
      }
    }
    assert.equal(
      observation['peakTreeRssBytes'],
      Math.max(...resources.map((x) => Number(object(x)['rssBytes'])))
    )
    assert.equal(
      observation['peakTreeThreads'],
      Math.max(...resources.map((x) => Number(object(x)['threads'])))
    )
    assert.equal(observation['cancelled'], false)
    assert.equal(observation['outputOverflow'], false)
    assert.equal(observation['orphanCount'], 0)
    assert.equal(observation['survivorCount'], 0)
    if (hang && (mode === 'import' || mode === 'graph')) {
      assert.equal(observation['timedOut'], true)
      assert.ok(Number.isSafeInteger(observation['exitCode']) && observation['exitCode'] !== 0)
      assert.equal(row['outcome'], 'owner-process-unresponsive-forced-restart-required')
      assert.equal(row['expectedApplicationFailure'], true)
      assert.deepEqual(row['loopEntryReceipt'], {
        event: 'loop-entered',
        mode,
        stableListenerCreated: true,
      })
      assert.equal(row['result'], undefined)
      outcomes.push({ candidate: mode, outcome: row['outcome'] })
    } else {
      assert.equal(observation['timedOut'], false)
      assert.equal(observation['exitCode'], 0)
      assert.match(String(row['resultSha256']), /^[a-f0-9]{64}$/)
      const result = object(row['result'])
      assert.equal(
        row['resultSha256'],
        createHash('sha256')
          .update(JSON.stringify(result, null, 2) + '\n')
          .digest('hex')
      )
      if (!hang) assert.deepEqual(row['summary'], reloadProbeSummary(result))
      assert.equal(`${result['platform']}-${result['arch']}`, report['target'])
      const accepted = acceptReloadProbe(result, mode, 20, hang, options)
      assert.deepEqual(row['acceptance'], accepted)
      outcomes.push(accepted)
    }
  }
  return outcomes
}

/** Recomputed from retained rows, never accepted solely from a summary field. */
export function reloadProbeSummary(result: Record<string, unknown>) {
  const rows = result['trials']
  assert.ok(Array.isArray(rows) && rows.length >= 1 && rows.length <= 100)
  const describe = (metric: string) => {
    const values = rows.map((row) => object(row)[metric] as number)
    for (const value of values) finite(value, 60000)
    return {
      count: values.length,
      min: Math.min(...values),
      median: quantile(values, 0.5),
      p95: quantile(values, 0.95),
      max: Math.max(...values),
      method: 'within-process sequential samples; no independent-trial confidence interval',
    }
  }
  return { loadMs: describe('loadMs'), disposeRequestMs: describe('disposeRequestMs') }
}

/** Deliberately excludes identities, command lines, paths and raw output. */
export function reloadObservationResources(input: unknown) {
  const observation = object(input)
  const samples = observation['samples']
  assert.ok(Array.isArray(samples) && samples.length >= 1 && samples.length <= 4000)
  return samples.map((value) => {
    const sample = object(value),
      processes = sample['processes']
    assert.ok(Array.isArray(processes))
    const descriptors = processes.map((process) => object(process)['descriptors'])
    const complete =
      descriptors.length > 0 &&
      descriptors.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
    return {
      elapsedMs: sample['elapsedMs'],
      rssBytes: sample['rssBytes'],
      threads: sample['threads'],
      processes: processes.length,
      descriptors: complete
        ? descriptors.reduce<number>((sum, value) => sum + Number(value), 0)
        : null,
    }
  })
}

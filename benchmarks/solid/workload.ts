import { createApplication, type NativeApplication, type NativeWindow } from '@bun-native/core'
import { heapStats } from 'bun:jsc'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'

export type Row = Readonly<{ id: number; text: string }>
export type Mutations = { create: number; set: number; insert: number; remove: number }
export interface MeasuredView {
  update(values: readonly string[]): Promise<void>
  rotate(rows: readonly Row[]): Promise<void>
  dispose(): Promise<void>
  readonly probes: readonly WeakRef<object>[]
  inspect(): {
    mutations: Mutations
    rowsCreated: number
    rowsDisposed: number
    unexpectedClicks: number
  }
}
export type Mount = (window: NativeWindow, rows: readonly Row[]) => Promise<MeasuredView>
export const CONTENT_STYLE = { direction: 'column', gap: 8, padding: 16 } as const
export const LIST_STYLE = { direction: 'column', gap: 0 } as const
export const ROW_STYLE = { font_size: 12 } as const

export function count(value: string | undefined, name: string, maximum: number) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(`${name} must be an integer in 1..${maximum}`)
  return parsed
}

function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
  return {
    count: samples.length,
    p50Ms: rank(0.5),
    p95Ms: rank(0.95),
    p99Ms: rank(0.99),
    totalMs: samples.reduce((sum, value) => sum + value, 0),
    samplesMs: samples,
  }
}

async function heapSnapshot(phase: string) {
  // Collection and heap walking are outside all mutation timing samples.
  await Bun.sleep(1)
  const start = performance.now()
  Bun.gc(true)
  const stats = heapStats()
  return {
    phase,
    collectionAndWalkMs: performance.now() - start,
    heapSize: stats.heapSize,
    heapCapacity: stats.heapCapacity,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
    protectedObjectCount: stats.protectedObjectCount,
    objectTypeCounts: stats.objectTypeCounts,
    protectedObjectTypeCounts: stats.protectedObjectTypeCounts,
    applicationRss: process.memoryUsage().rss,
  }
}

function expectedNodes(rows: readonly Row[], label: string) {
  return [
    { node_id: 1, element: { kind: 'box', style: {} }, children: [2] },
    { node_id: 2, element: { kind: 'box', style: {} }, children: [3] },
    { node_id: 3, element: { kind: 'box', style: CONTENT_STYLE }, children: [4, 5, 6] },
    { node_id: 4, element: { kind: 'text', text: label, style: {} }, children: [] },
    {
      node_id: 5,
      element: { kind: 'button', text: 'Benchmark fixture', disabled: false, style: {} },
      children: [],
    },
    {
      node_id: 6,
      element: { kind: 'box', style: LIST_STYLE },
      children: rows.map((row) => row.id + 7),
    },
    ...[...rows]
      .sort((a, b) => a.id - b.id)
      .map((row) => ({
        node_id: row.id + 7,
        element: { kind: 'text', text: row.text, style: ROW_STYLE },
        children: [],
      })),
  ]
}

async function observedPaint(path: string, nonce: string, revision: number, nodes: unknown) {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    if (!existsSync(path)) {
      await Bun.sleep(5)
      continue
    }
    if (statSync(path).size > 4_194_304) throw new Error('Calibration evidence exceeds 4 MiB')
    // A writer may still be appending its last record. Only completed lines count.
    const events: unknown[] = readFileSync(path, 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line))
    const records = events.filter(
      (value): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
    )
    assert.equal(records.length, events.length, 'Invalid native calibration record')
    assert(
      records.every((event) => event['nonce'] === nonce),
      'Foreign calibration nonce'
    )
    const paint = records.findLast(
      (event) => event['type'] === 'rendered' && event['tree_revision'] === revision
    )
    if (paint) {
      assert.equal(paint['stage'], 'native-paint')
      assert.deepEqual(paint['nodes'], nodes)
      const renderer = records.find((event) => event['type'] === 'renderer')
      assert(renderer, 'Native calibration must report its actual GPU adapter')
      return { renderer, paint }
    }
    await Bun.sleep(5)
  }
  throw new Error(`Native calibration did not paint tree revision ${revision}`)
}

function delta(after: Mutations, before: Mutations): Mutations {
  return {
    create: after.create - before.create,
    set: after.set - before.set,
    insert: after.insert - before.insert,
    remove: after.remove - before.remove,
  }
}

function expectWindowRootOnly(application: NativeApplication): void {
  assert.deepEqual(application.diagnostics, {
    windows: 1,
    nodes: 1,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
  })
}

/** The external controller binds reports to exact development/AOT artifacts. */
export async function runWorkload(adapter: 'solid' | 'core', mount: Mount) {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      output: { type: 'string' },
      nonce: { type: 'string' },
      mode: { type: 'string' },
      iterations: { type: 'string', default: '1000' },
      rotations: { type: 'string', default: '1000' },
      mounts: { type: 'string', default: '100' },
      rows: { type: 'string', default: '32' },
      calibration: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
  if (!values.host || !isAbsolute(values.host) || !values.output || !isAbsolute(values.output))
    throw new Error('--host and --output require absolute paths')
  if (!values.nonce || values.nonce.length > 128) throw new Error('--nonce is required')
  if (values.mode !== 'development' && values.mode !== 'aot')
    throw new Error('--mode must be development or aot; the controller verifies it')
  const iterations = count(values.iterations, 'iterations', 10_000)
  const rotations = count(values.rotations, 'rotations', 10_000)
  const mounts = count(values.mounts, 'mounts', 1_000)
  const rowCount = count(values.rows, 'rows', 128)
  if (iterations % 10 !== 0) throw new Error('iterations must be a multiple of 10')
  const initial = Array.from({ length: rowCount }, (_, id) => ({ id, text: `Row ${id}` }))
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'running',
    adapter,
    nonce: values.nonce,
    declaredMode: values.mode,
    executable: process.execPath,
    bunRevision: Bun.revision,
    workload: { iterations, rotations, mounts, rows: rowCount, warmup: 20 },
    methodology: {
      timings: 'application update submission through public-core acknowledgement',
      synchronousSubmission:
        'only the synchronous setter/batch call; deferred planning is in acknowledgement time',
      presentation: 'not measured; an acknowledgement is not display presentation',
      heap: 'live JSC heap after full GC; not cumulative allocation or native heap totals',
      nativeRss: 'not measured by this runner',
      instrumentation: values.calibration
        ? 'separate native paint/GPU calibration; excluded from timed comparisons'
        : 'native evidence disabled for the timed comparison',
      retainedProbeObjects: mounts * 3,
    },
  }
  let application: NativeApplication | undefined
  let active: MeasuredView | undefined
  let failure: unknown
  const started = performance.now()
  const deadline = started + 120_000
  function withinDeadline() {
    if (performance.now() > deadline) throw new Error('Solid/core workload exceeded 120 seconds')
  }
  try {
    const evidence = process.env['BUN_NATIVE_EVIDENCE_LOG']
    if (values.calibration) {
      assert(evidence && isAbsolute(evidence), 'Calibration requires an explicit evidence path')
      assert.equal(process.env['BUN_NATIVE_EVIDENCE_NONCE'], values.nonce)
    } else {
      delete process.env['BUN_NATIVE_EVIDENCE_LOG']
      delete process.env['BUN_NATIVE_EVIDENCE_NONCE']
    }
    application = await createApplication({ executable: values.host, requestTimeoutMs: 10_000 })
    const window = await application.openWindow({
      title: 'Bun Native matched renderer workload',
      width: 640,
      height: 720,
    })
    active = await mount(window, initial)
    if (values.calibration)
      result['initialNativePaint'] = await observedPaint(
        evidence!,
        values.nonce,
        1,
        expectedNodes(initial, 'Initial')
      )
    for (let index = 0; index < 20; index++) {
      withinDeadline()
      await active.update([`Warmup ${index}`])
    }
    const beforeHeap = await heapSnapshot('mounted view after 20 warmup updates')
    const initialMutations = active.inspect().mutations
    const phases: Record<string, unknown> = {}
    result['phases'] = phases
    async function measure(
      name: string,
      count: number,
      operation: (index: number) => Promise<void>
    ) {
      const acknowledgement: number[] = []
      const submission: number[] = []
      const before = active!.inspect().mutations
      for (let index = 0; index < count; index++) {
        withinDeadline()
        const start = performance.now()
        const pending = operation(index)
        submission.push(performance.now() - start)
        await pending
        acknowledgement.push(performance.now() - start)
      }
      phases[name] = {
        acknowledgement: distribution(acknowledgement),
        synchronousSubmission: distribution(submission),
        mutations: delta(active!.inspect().mutations, before),
      }
    }
    await measure('signals', iterations, (index) => active!.update([`Update ${index}`]))
    const coalesced = Array.from({ length: 10 }, (_, index) => `Batched ${index}`)
    await measure('coalesced', iterations / 10, (index) =>
      active!.update(coalesced.map((value) => `${index}: ${value}`))
    )
    let ordered = initial
    await measure('keyedRotations', rotations, () => {
      ordered = [...ordered.slice(1), ordered[0]!]
      return active!.rotate(ordered)
    })
    assert.deepEqual(delta(active.inspect().mutations, initialMutations), {
      create: 0,
      set: iterations + iterations / 10,
      insert: rowCount === 1 ? 0 : rotations,
      remove: 0,
    })
    assert.equal(active.inspect().rowsCreated, rowCount)
    assert.equal(active.inspect().rowsDisposed, 0)
    assert.equal(active.inspect().unexpectedClicks, 0)
    if (values.calibration)
      result['finalNativePaint'] = await observedPaint(
        evidence!,
        values.nonce,
        window.revision,
        expectedNodes(ordered, `${iterations / 10 - 1}: Batched 9`)
      )
    await active.dispose()
    assert.equal(active.inspect().rowsDisposed, rowCount)
    active = undefined
    expectWindowRootOnly(application)
    const afterUpdatesHeap = await heapSnapshot('view disposed; timing arrays retained')
    const probes: WeakRef<object>[] = []
    const lifecycle: number[] = []
    let rowsCreated = 0
    let rowsDisposed = 0
    async function cycle() {
      const view = await mount(window, initial)
      await view.dispose()
      const state = view.inspect()
      rowsCreated += state.rowsCreated
      rowsDisposed += state.rowsDisposed
      assert.equal(state.unexpectedClicks, 0)
      return view.probes
    }
    for (let index = 0; index < mounts; index++) {
      withinDeadline()
      const start = performance.now()
      probes.push(...(await cycle()))
      lifecycle.push(performance.now() - start)
      expectWindowRootOnly(application)
    }
    assert.equal(probes.length, mounts * 3)
    assert.equal(rowsCreated, rowCount * mounts)
    assert.equal(rowsDisposed, rowsCreated)
    result['lifecycles'] = {
      ...distribution(lifecycle),
      rowsCreated,
      rowsDisposed,
      retainedWeakRefObjects: probes.length,
    }
    await Bun.sleep(1)
    Bun.gc(true)
    const firstReachable = probes.flatMap((probe, index) =>
      probe.deref() === undefined ? [] : [index]
    )
    // Exactly one JS/core queue fence after acknowledged disposal. It sends no
    // native command and is outside timed samples; never repeat until zero.
    await window.batch(() => undefined)
    const afterLifecyclesHeap = await heapSnapshot(
      'all views disposed; collection after a core queue fence and timer turn; timing/WeakRef instrumentation retained'
    )
    const stillReachable = probes.flatMap((probe, index) =>
      probe.deref() === undefined ? [] : [index]
    )
    result['retentionObservation'] = {
      firstReachable,
      stillReachable,
      probesPerMount: 3,
      probeKinds:
        adapter === 'core'
          ? ['container handle', 'label handle', 'listener']
          : ['render root', 'content node', 'listener'],
      collectionCheckpoints: 2,
      quiescence: 'empty core transaction queue fence; no additional native command',
    }
    result['heap'] = {
      before: beforeHeap,
      afterUpdates: afterUpdatesHeap,
      afterLifecycles: afterLifecyclesHeap,
    }
    expectWindowRootOnly(application)
    assert.equal(stillReachable.length, 0, 'Disposed view/callback targets remain observable')
    await window.close()
  } catch (error) {
    failure = error
  } finally {
    for (const cleanup of [
      () => active?.dispose(),
      () => application?.shutdown(),
      () => application?.closed,
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], 'Workload and cleanup failed')
          : error
      }
    }
    result['cleanup'] = application?.diagnostics ?? null
    if (application) {
      try {
        assert.deepEqual(application.diagnostics, {
          windows: 0,
          nodes: 0,
          callbacks: 0,
          queuedTransactions: 0,
          queuedCallbacks: 0,
          activeCallbacks: 0,
        })
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], 'Workload and ownership cleanup failed')
          : error
      }
    }
    result['totalWorkloadMs'] = performance.now() - started
    result['status'] = failure ? 'failed' : 'passed'
    if (failure) result['error'] = failure instanceof Error ? failure.stack : String(failure)
    writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  if (failure) throw failure
}

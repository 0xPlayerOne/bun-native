import { createApplication, type NativeWindow } from '@bun-native/core'
import type { RenderRoot } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { STREAMING_LIST_FIXTURE } from '../../benchmarks/streaming-list-fixture.ts'
import {
  DENSITIES,
  FRAME_NODES,
  LISTENERS_PER_ROW,
  MAX_ROWS,
  NODES_PER_ROW,
  StreamingList,
  type ListView,
} from './streaming-list-model.ts'

export interface MountedList {
  root: RenderRoot
  /** Latest view the framework rendered from; equal to the model after a flush. */
  rendered(): ListView
  publish(view: ListView): void
  disposed(): boolean
}
export type MountList = (
  window: NativeWindow,
  initial: ListView,
  select: (id: number) => void
) => MountedList

const SAMPLE_MS = 250
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024
const NODE_BOUND = FRAME_NODES + MAX_ROWS * NODES_PER_ROW
const LISTENER_BOUND = MAX_ROWS * LISTENERS_PER_ROW

function distribution(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (fraction: number) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
      : null
  return {
    count: sorted.length,
    p50Ms: rank(0.5),
    p95Ms: rank(0.95),
    p99Ms: rank(0.99),
    maxMs: sorted.at(-1) ?? null,
  }
}

/**
 * Both real adapters replay one deterministic stream against the same host,
 * key routing, invariants and lifetime oracle. Only `mount` differs.
 */
export async function runStreamingList(
  framework: 'React' | 'Solid',
  mount: MountList
): Promise<void> {
  const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
  const executable = process.env['BUN_NATIVE_HOST']
  const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
  const scenario = `${framework.toLowerCase()}-streaming-list`
  if (
    !directory ||
    !isAbsolute(directory) ||
    !executable ||
    !nonce ||
    process.env['BUN_NATIVE_DIAGNOSTICS_SCENARIO'] !== scenario
  )
    throw new Error('Use the owned native streaming-list controller with its host and nonce')
  let bytes = 0
  function record(type: string, fields: Record<string, unknown> = {}) {
    const line = JSON.stringify({ nonce, type, framework, ...fields }) + '\n'
    bytes += Buffer.byteLength(line)
    assert(bytes <= MAX_EVIDENCE_BYTES, 'Streaming-list evidence must remain bounded')
    appendFileSync(join(directory!, 'application.jsonl'), line)
  }

  const model = new StreamingList()
  const app = await createApplication({ executable })
  let view: MountedList | undefined
  let window!: NativeWindow
  let producer: ReturnType<typeof setInterval> | undefined
  let sampler: ReturnType<typeof setInterval> | undefined
  const latencies: number[] = []
  const keys: string[] = []
  const signals = new Set<AbortSignal>()
  let pointerSelections = 0
  let probing = false
  let detachedTicks = 0
  let detachedStructuralChanges = 0
  let maxNodes = 0
  let maxListeners = 0
  let maxCallbacks = 0
  let streamStarted = 0
  let streamCompleted = 0
  let failure: unknown
  let ended = false
  let navigations = 0
  let pendingNavigations = 0
  let completedSettled = false

  const publish = () => view!.publish(model.view())
  /** A user action may legitimately move the window; exclude its commit from the oracle. */
  function navigate() {
    navigations++
    pendingNavigations++
    publish()
    void view!.root
      .flush()
      .catch((error: unknown) => {
        if (!ended) throw error
      })
      .finally(() => pendingNavigations--)
      .catch(fail)
  }
  function fail(cause: unknown) {
    failure ??= cause
    void window?.close().catch(() => {})
  }
  function bounded() {
    const root = view!.root.diagnostics
    const owner = app.diagnostics
    maxNodes = Math.max(maxNodes, root.nodes)
    maxListeners = Math.max(maxListeners, root.listeners)
    maxCallbacks = Math.max(maxCallbacks, owner.callbacks)
    assert(root.nodes <= NODE_BOUND, `Native nodes ${root.nodes} exceed the window bound`)
    assert(root.listeners <= LISTENER_BOUND, `Listeners ${root.listeners} exceed the row bound`)
    // Root keyboard capture plus window-lifetime observers; never per message.
    assert(owner.callbacks <= LISTENER_BOUND + 4, 'Core callbacks must stay bounded')
    return { root, owner }
  }
  function settled(): boolean {
    const rendered = view!.rendered()
    const nodes = view!.root.diagnostics.nodes
    return nodes === FRAME_NODES + rendered.rows.length * NODES_PER_ROW
  }
  async function probe(started: number) {
    // Update-to-native-acknowledgement latency through the adapter's own commit.
    probing = true
    try {
      await view!.root.flush()
      latencies.push(performance.now() - started)
    } catch (error) {
      if (!ended) throw error
    } finally {
      probing = false
    }
  }

  function tick() {
    if (!view || view.disposed()) return
    const before = model.view()
    if (!model.stream()) {
      clearInterval(producer)
      producer = undefined
      streamCompleted = performance.now()
      void view.root
        .flush()
        .then(() => {
          completedSettled = settled()
          record('stream-complete', {
            settled: completedSettled,
            diagnostics: view!.root.diagnostics,
            ticks: model.tick,
            total: model.total,
            durationMs: streamCompleted - streamStarted,
            digest: model.digest(),
          })
        })
        .catch(fail)
      return
    }
    const after = model.view()
    if (!before.follow && !after.follow) {
      // A detached window must not move: same anchor, rows and selection.
      detachedTicks++
      assert.equal(after.anchor, before.anchor, 'Streaming moved a detached anchor')
      assert.equal(after.selected, before.selected, 'Streaming changed a detached selection')
      assert.deepEqual(
        after.rows.map((row) => row.id),
        before.rows.map((row) => row.id),
        'Streaming changed the detached window'
      )
    }
    publish()
    if (!probing) void probe(performance.now()).catch(fail)
  }

  try {
    window = await app.openWindow({
      title: `Bun Native ${framework} Streaming List`,
      width: 960,
      height: 640,
    })
    // Unfocused native keys target the window root, outside the render root.
    window.on(
      window.root,
      'key_down',
      (event) => {
        try {
          signals.add(event.signal)
          if (!model.key(event.key)) return
          keys.push(event.key)
          navigate()
          const state = model.view()
          record('navigation', {
            key: event.key,
            sequence: event.sequence,
            anchor: state.anchor,
            selected: state.selected,
            follow: state.follow,
            theme: state.theme,
            density: state.density,
            tick: model.tick,
          })
        } catch (error) {
          fail(error)
        }
      },
      { capture: true }
    )
    view = mount(window, model.view(), (id) => {
      try {
        if (!model.select(id)) return
        pointerSelections++
        navigate()
        const state = model.view()
        record('pointer-selection', { id, anchor: state.anchor, follow: state.follow })
      } catch (error) {
        fail(error)
      }
    })
    await view.root.ready
    assert(settled(), 'Mounted tree must contain exactly the visible window')
    const mounted = bounded()
    record('mounted', {
      treeRevision: window.revision,
      diagnostics: mounted.root,
      fixture: STREAMING_LIST_FIXTURE,
      rows: model.view().rows.length,
      history: model.total,
    })
    // Baseline of the previous sample, only when it was detached with no
    // navigation commit in flight. Streaming alone must then emit only sets.
    let baseline: { create: number; remove: number; navigations: number } | undefined
    sampler = setInterval(() => {
      try {
        if (!view || view.disposed() || ended) return
        const { root, owner } = bounded()
        const quiet = !model.following && pendingNavigations === 0 && producer !== undefined
        if (quiet && baseline && baseline.navigations === navigations)
          detachedStructuralChanges +=
            root.mutations.create - baseline.create + root.mutations.remove - baseline.remove
        baseline = quiet
          ? { create: root.mutations.create, remove: root.mutations.remove, navigations }
          : undefined
        const memory = process.memoryUsage()
        record('sample', {
          at: performance.now(),
          tick: model.tick,
          total: model.total,
          follow: model.following,
          nodes: root.nodes,
          listeners: root.listeners,
          commits: root.commits,
          mutations: root.mutations,
          ownership: owner,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
        })
      } catch (error) {
        fail(error)
      }
    }, SAMPLE_MS)
    // The owned controller starts the stream once the window is observable.
    await new Promise<void>((resolve, reject) => {
      const wait = setInterval(() => {
        if (existsSync(join(directory, 'start'))) {
          clearInterval(wait)
          resolve()
        } else if (view!.disposed()) {
          clearInterval(wait)
          reject(new Error('Window closed before the stream started'))
        }
      }, 10)
    })
    streamStarted = performance.now()
    const start = view.root.diagnostics
    record('stream-start', { commits: start.commits, tick: model.tick })
    producer = setInterval(() => {
      try {
        tick()
      } catch (error) {
        fail(error)
      }
    }, STREAMING_LIST_FIXTURE.tickIntervalMs)
    void window.closed.then(() => {
      ended = true
    })
    await Promise.race([window.closed, view.root.closed])
    ended = true
    clearInterval(producer)
    clearInterval(sampler)
    if (failure) throw failure
    const final = view.rendered()
    const diagnostics = view.root.diagnostics
    await view.root.dispose()
    assert(view.disposed(), 'OS close disposes the framework owner')
    assert(streamCompleted > 0, 'The OS close arrived after the complete stream')
    assert(completedSettled, 'The final tree contained exactly the visible window')
    assert.equal(model.tick, STREAMING_LIST_FIXTURE.ticks)
    assert(detachedTicks > 0, 'The controller detached the view while the stream was active')
    assert.equal(detachedStructuralChanges, 0, 'A detached window created or removed rows')
    assert(pointerSelections > 0, 'An OS pointer selected a visible row')
    for (const key of ['up', 'pageup', 'home', 'down', 'end', 'f7', 'f8'])
      assert(keys.includes(key), `The owned controller must deliver ${key}`)
    assert.equal(final.follow, true)
    assert.equal(final.selected, model.total)
    assert.equal(final.rows.length, DENSITIES[final.density].rows)
    assert.equal(view.root.diagnostics.nodes, 0)
    assert.equal(view.root.diagnostics.listeners, 0)
    assert(signals.size > 0)
    record('disposed', { diagnostics: view.root.diagnostics })
    writeFileSync(
      join(directory, 'application-result.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          status: 'passed',
          scenario,
          framework,
          fixture: STREAMING_LIST_FIXTURE,
          final: {
            total: model.total,
            anchor: final.anchor,
            selected: final.selected,
            theme: final.theme,
            density: final.density,
            digest: model.digest(),
          },
          stream: {
            ticks: model.tick,
            durationMs: streamCompleted - streamStarted,
            // Deltas over the stream and its interleaved OS navigation only.
            commits: diagnostics.commits - start.commits,
            mutations: Object.fromEntries(
              Object.entries(diagnostics.mutations).map(([kind, value]) => [
                kind,
                value - start.mutations[kind as keyof typeof start.mutations],
              ])
            ),
            detachedTicks,
            detachedStructuralChanges,
            pointerSelections,
            keys,
            updateToAck: distribution(latencies),
          },
          bounds: {
            nodeBound: NODE_BOUND,
            listenerBound: LISTENER_BOUND,
            maxNodes,
            maxListeners,
            maxCallbacks,
          },
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    clearInterval(producer)
    clearInterval(sampler)
    try {
      await view?.root.dispose()
    } finally {
      await app.shutdown()
      await app.closed
    }
  }
  assert(Object.values(app.diagnostics).every((value) => value === 0))
}

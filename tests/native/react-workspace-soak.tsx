/** @jsxImportSource @bun-native/react */
import { createApplication } from '@bun-native/core'
import {
  focusNode,
  inputState,
  render,
  type NativeRef,
  type ReactRenderRoot,
} from '@bun-native/react'
import { heapStats } from 'bun:jsc'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Dispatch } from 'react'
import { Workspace } from '../../examples/react-workspace/app.tsx'
import {
  PLAN_STEPS,
  type PlanScheduler,
  type WorkspaceAction,
  type WorkspaceState,
} from '../../examples/react-workspace/model.ts'
import {
  distribution,
  ownedHost,
  processSample,
  sessionConfig,
  SessionRecorder,
  waitUntil,
  X11Input,
} from './workspace-session.ts'

/**
 * Long-session ownership fixture for the unchanged React workspace (#248),
 * the counterpart of the Solid workspace soak.
 *
 * The same component runs through many rounds of task add/rename/remove,
 * filtering and search, plan streaming (complete, stopped with a stale
 * callback, and cancelled by a selection change), theme toggles and the
 * in-app clear confirmation (dismissed, then confirmed, which mounts and
 * removes its modal overlay). A fixture-owned plan clock replaces the 300 ms
 * timer so the session is long in work, not in wall time. Each action is the
 * component's own reducer dispatch and waits for React's commit and its
 * native acknowledgement.
 *
 * Every round returns to the mounted workspace shape, so native nodes,
 * listeners and public resources must equal the mounted baseline exactly.
 * Memory samples are recorded observations of this single run; they are not a
 * leak-freedom, latency or capacity claim. There is no OS input in the fixed
 * plan: the separate react-workspace scenario covers real X11 interaction and
 * OS close.
 *
 * With BUN_NATIVE_SOAK_SECONDS (see workspace-session.ts) the same round runs
 * until that wall time passes, samples on a wall-clock interval, can pace each
 * plan step and, with BUN_NATIVE_SOAK_OS_INPUT=1, types each round's task title
 * into the focused composer and adds it with Return through X11, and wheels
 * the task list down and up.
 */
const host = process.env['BUN_NATIVE_HOST']
const peer = process.env['BUN_NATIVE_WORKSPACE_TEST_PEER']
const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const native = peer === undefined
if (native && (!host || !directory || !isAbsolute(directory)))
  throw new Error('Set BUN_NATIVE_HOST and an absolute BUN_NATIVE_DIAGNOSTICS_DIR')
const session = sessionConfig(native)
const ROUNDS = native ? 60 : 3
const SAMPLE_EVERY = native ? 10 : 1
const TITLE = 'Bun Native React Workspace Soak'
const PLANS_PER_ROUND = 8
const STEPS = PLAN_STEPS.length

const executable = native ? resolve(host!) : process.execPath
const app = await createApplication({
  executable,
  // The headless peer advertises the overlay and focus capabilities the
  // clear confirmation uses; the real host always does.
  args: native ? [] : [peer!, '--overlays', '--keyboard', '--split-resize'],
})
let root: ReactRenderRoot | undefined
let dispatch: Dispatch<WorkspaceAction> | undefined
let state: WorkspaceState | undefined
let pending: (() => void) | undefined
let scheduledTimers = 0
let cancelledTimers = 0
let ignoredStaleCallbacks = 0
let actions = 0
let completedPlans = 0
let stoppedPlans = 0
let switchedPlans = 0
let composer: NativeRef | undefined
let typedTasks = 0
const recorder = new SessionRecorder(native ? directory : undefined)

// Fixture-owned plan clock: at most one timer, cancellation is observable.
const schedule: PlanScheduler = (callback) => {
  assert.equal(pending, undefined, 'The workspace must never own two plan timers')
  pending = callback
  scheduledTimers++
  return () => {
    if (pending !== callback) return
    pending = undefined
    cancelledTimers++
  }
}

const started = performance.now()
const samples: Array<Record<string, unknown>> = []
const roundDurationsMs: number[] = []
let hostPid: number | undefined
let lastSample = 0

async function sample(round: number) {
  // Sparse measurement only: collect, then count observed live cells.
  await Bun.sleep(0)
  Bun.gc(true)
  await Bun.sleep(0)
  const statistics = heapStats()
  const hostProcess = processSample(hostPid)
  const elapsedMs = performance.now() - started
  lastSample = elapsedMs
  samples.push(
    recorder.record({
      round,
      elapsedMs,
      commits: root!.diagnostics.commits,
      actions,
      heapSize: statistics.heapSize,
      objectCount: statistics.objectCount,
      protectedObjectCount: statistics.protectedObjectCount,
      bunRssBytes: process.memoryUsage().rss,
      hostRssKiB: hostProcess?.rssKiB ?? null,
      host: hostProcess,
      app: processSample(native ? process.pid : undefined),
      rootNodes: root!.diagnostics.nodes,
      rootListeners: root!.diagnostics.listeners,
      application: app.diagnostics,
      pendingTimers: pending === undefined ? 0 : 1,
    })
  )
}

function shape(value: WorkspaceState) {
  return {
    tasks: value.tasks,
    selectedId: value.selectedId,
    filter: value.filter,
    query: value.query,
    theme: value.theme,
    plan: value.plan,
    confirmingClear: value.confirmingClear,
  }
}

try {
  const window = await app.openWindow({
    title: TITLE,
    width: 1000,
    height: 760,
  })
  root = render(
    <Workspace
      schedule={schedule}
      onChange={(next) => {
        state = next
      }}
      onDispatch={(owned) => {
        dispatch = owned
      }}
      onComposer={(owned) => {
        composer = owned
      }}
    />,
    window,
    { style: { width: 'fill', height: 'fill' } }
  )
  await root.ready
  await root.flush()
  hostPid = native ? ownedHost(executable) : undefined
  if (native && platform() === 'linux') assert(hostPid, 'The owned native host must be observable')
  assert(dispatch && state, 'The component must expose its dispatch and state to this fixture')
  const initial = state
  const initialShape = shape(initial)
  const baseline = {
    rootNodes: root.diagnostics.nodes,
    rootListeners: root.diagnostics.listeners,
    application: app.diagnostics,
  }

  const input = session?.osInput ? await X11Input.open(TITLE, hostPid!) : undefined

  async function act(action: WorkspaceAction | (() => void)) {
    const begun = performance.now()
    if (typeof action === 'function') action()
    else dispatch!(action)
    actions++
    await root!.flush()
    assert.equal(root!.diagnostics.pending, false)
    recorder.ack(performance.now() - begun)
  }

  async function tick(count: number) {
    for (let index = 0; index < count; index++) {
      if (session?.paceMs) await Bun.sleep(session.paceMs)
      const callback = pending
      assert(callback, 'A streaming plan must own one scheduled step')
      pending = undefined
      await act(callback)
    }
  }

  const live = () => state!
  await sample(0)

  // Real X11 typing into the focused composer, then Return through the app's
  // own key handler, which dispatches the same add action.
  async function typeTask(title: string) {
    const typing = input!
    assert(composer, 'The mounted workspace must expose its composer')
    await focusNode(composer)
    typing.activate()
    const typed = performance.now()
    typing.type(title)
    await waitUntil(() => inputState(composer!).value === title, 'the typed task title')
    recorder.input(performance.now() - typed)
    const sent = performance.now()
    typing.key('Return')
    await waitUntil(
      () => live().tasks.some((task) => task.title === title),
      'the Return-added task'
    )
    recorder.input(performance.now() - sent)
    await root!.flush()
    await waitUntil(() => inputState(composer!).value === '', 'the cleared composer')
    typedTasks++
    actions += 2
  }

  let round = 0
  while (session ? performance.now() - started < session.seconds * 1000 : round < ROUNDS) {
    round++
    const roundStarted = performance.now()
    const id = live().nextId
    if (input) await typeTask(`Round ${round} task`)
    else await act({ type: 'add', title: `Round ${round} task` })
    assert.equal(live().selectedId, id)
    for (let index = 0; index < PLANS_PER_ROUND; index++) {
      const planId = live().nextPlanId
      await act({ type: 'plan-start' })
      const plan = () => {
        const current = live().plan
        assert(current && current.id === planId && current.taskId === id)
        return current
      }
      switch (index % 4) {
        case 0:
        case 1:
          await tick(STEPS)
          assert.equal(pending, undefined)
          assert.equal(plan().status, 'complete')
          completedPlans++
          break
        case 2: {
          await tick(3)
          const stale = pending
          assert(stale)
          await act({ type: 'plan-stop' })
          assert.equal(pending, undefined)
          // A stopped plan's callback that still fires must not write anything.
          const before = live()
          const staged: Record<string, number> = { ...root.diagnostics.mutations }
          await act(stale)
          assert.equal(live(), before)
          assert.deepEqual(root.diagnostics.mutations, staged)
          ignoredStaleCallbacks++
          assert.equal(plan().status, 'stopped')
          assert.equal(plan().steps.length, 3)
          stoppedPlans++
          break
        }
        default:
          await tick(2)
          // Selecting another task stops the plan and remounts the keyed details.
          await act({ type: 'select', id: initial.selectedId! })
          assert.equal(pending, undefined)
          await act({ type: 'select', id })
          assert.equal(plan().status, 'stopped')
          assert.equal(plan().steps.length, 2)
          switchedPlans++
      }
      await act({ type: 'theme' })
    }
    if (input) {
      // Inside the task list's scroll viewport (layout of the react-workspace
      // scenario at this window size); the scroll itself is not asserted here.
      input.wheel(500, 420, 5, 12)
      input.wheel(500, 420, 4, 12)
      await root.flush()
    }

    await act({ type: 'rename', id, title: `Round ${round} renamed` })
    await act({ type: 'filter', filter: 'completed' })
    await act({ type: 'filter', filter: 'active' })
    await act({ type: 'search', query: 'renamed' })
    await act({ type: 'search', query: '' })
    await act({ type: 'filter', filter: 'all' })
    const extra = live().nextId
    await act({ type: 'add', title: `Round ${round} extra` })
    await act({ type: 'remove', id: extra })
    assert(!live().tasks.some((task) => task.id === extra))
    await act({ type: 'select', id })

    // Only this round's task is completed, so the in-app clear removes it alone.
    await act({ type: 'toggle', id: 1 })
    await act({ type: 'toggle', id })
    await act({ type: 'clear-request' })
    assert.equal(live().confirmingClear, true)
    await act({ type: 'clear-dismiss' })
    assert(live().tasks.some((task) => task.id === id))
    await act({ type: 'clear-request' })
    await act({ type: 'clear-confirm' })
    assert(!live().tasks.some((task) => task.id === id))
    assert.equal(live().plan, null, "A cleared task's plan is dropped")
    await act({ type: 'toggle', id: 1 })
    await act({ type: 'select', id: initial.selectedId! })

    // The round restored the mounted shape; ownership must not accumulate.
    assert.deepEqual(shape(live()), initialShape)
    assert.equal(root.diagnostics.nodes, baseline.rootNodes, `Round ${round} native nodes`)
    assert.equal(root.diagnostics.listeners, baseline.rootListeners, `Round ${round} listeners`)
    assert.deepEqual(app.diagnostics, baseline.application, `Round ${round} public resources`)
    assert.equal(pending, undefined)
    roundDurationsMs.push(performance.now() - roundStarted)
    if (session) {
      if (performance.now() - started - lastSample >= session.sampleSeconds * 1000)
        await sample(round)
    } else if (round % SAMPLE_EVERY === 0) await sample(round)
  }
  const rounds = round
  if (session && samples.at(-1)!['round'] !== rounds) await sample(rounds)
  if (input) assert.equal(typedTasks, rounds)

  const plans = rounds * PLANS_PER_ROUND
  assert.equal(completedPlans, plans / 2)
  assert.equal(stoppedPlans + switchedPlans, plans / 2)
  // Per four plans: two complete (8 + 8 steps), one stopped after three steps
  // (4 timers) and one switched away after two steps (3 timers).
  assert.equal(scheduledTimers, (plans * (STEPS + STEPS + 4 + 3)) / 4)
  assert.equal(cancelledTimers, plans / 2)
  const commits = root.diagnostics.commits
  const mutations = root.diagnostics.mutations
  await window.close()
  await root.closed
  await root.dispose()
  assert.equal(root.diagnostics.nodes, 0)
  assert.equal(root.diagnostics.listeners, 0)
  assert.equal(pending, undefined, 'Disposal must leave no plan timer')
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((value) => value === 0))
  if (hostPid !== undefined) {
    let exited = false
    try {
      readFileSync(`/proc/${hostPid}/status`)
    } catch {
      exited = true
    }
    assert(exited, 'The owned native host must exit after shutdown')
  }
  const report = {
    schemaVersion: 1,
    status: 'passed',
    scenario: 'react-workspace-soak',
    scope: !native
      ? 'Headless public adapter and owned protocol peer; no native rendering'
      : input
        ? 'Actual native host; fixture-driven component actions with native acknowledgements plus one X11-typed, Return-added task and unasserted wheel input per round; no paint assertion'
        : 'Actual native host; fixture-driven component actions with native acknowledgements; no OS input or paint assertion',
    system: { platform: platform(), architecture: arch(), release: release() },
    bun: { version: Bun.version, revision: Bun.revision },
    rounds,
    plans,
    completedPlans,
    stoppedPlans,
    switchedPlans,
    ignoredStaleCallbacks,
    scheduledTimers,
    cancelledTimers,
    actions,
    commits,
    mutations,
    baseline,
    elapsedMs: performance.now() - started,
    roundDurationsMs,
    samples,
    ...(session && {
      session: {
        ...session,
        ackMs: distribution(recorder.allAck),
        inputToStateMs: distribution(recorder.allInput),
        osInput: input ? { typedTasks, ...input.counts } : null,
      },
    }),
    final: { application: app.diagnostics, pendingTimers: pending === undefined ? 0 : 1 },
  }
  if (native) writeFileSync(join(directory!, 'soak-result.json'), JSON.stringify(report, null, 2))
  else console.log(JSON.stringify(report))
} finally {
  try {
    await root?.dispose()
  } finally {
    await app.shutdown()
    await app.closed
  }
}

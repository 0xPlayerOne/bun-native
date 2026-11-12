import { createApplication } from '@bun-native/core'
import { focusNode, render, type RenderRoot, type SolidNode } from '@bun-native/solid'
import { heapStats } from 'bun:jsc'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Workspace } from '../../examples/solid-workspace/app.tsx'
import {
  MAX_MESSAGES,
  selectedConversation,
  type ReplyScheduler,
  type WorkspaceController,
  type WorkspaceOwnership,
  type WorkspaceState,
} from '../../examples/solid-workspace/model.ts'
import { openOsInput } from './workspace-os-input.ts'
import {
  ownedHost,
  processSample,
  sessionConfig,
  writeStringCensus,
  SessionRecorder,
  waitUntil,
} from './workspace-session.ts'

/**
 * Long-session ownership fixture for the unchanged Solid workspace (#250).
 *
 * The same component and model run through many rounds of reply streaming,
 * cancellation, conversation switch/remount, history limit, in-app clear,
 * theme/details toggles and conversation create/close. A fixture-owned reply
 * clock replaces the 250 ms timer so the session is long in work, not in wall
 * time. Each action waits for the native acknowledgement of its Solid commit.
 *
 * Every round returns to the mounted workspace shape, so native nodes,
 * listeners and public resources must equal the mounted baseline exactly.
 * Memory samples are recorded observations of this single run; they are not a
 * leak-freedom, latency or capacity claim. There is no OS input in the fixed
 * plan: the separate solid-workspace scenario covers real X11 interaction and
 * OS close.
 *
 * With BUN_NATIVE_SOAK_SECONDS (see workspace-session.ts) the same round runs
 * until that wall time passes, samples on a wall-clock interval, can pace each
 * reply update and, with BUN_NATIVE_SOAK_OS_INPUT=1, types each round's first
 * prompt into the focused composer and sends it with Return through X11, and
 * wheels the full history down and up.
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
const TITLE = 'Bun Native Solid Workspace Soak'
const SENDS_PER_ROUND = MAX_MESSAGES / 2
const CHUNKS_PER_REPLY = 8

const executable = native ? resolve(host!) : process.execPath
const app = await createApplication({ executable, args: native ? [] : [peer!] })
let root: RenderRoot | undefined
let controller: WorkspaceController | undefined
let disposedState: WorkspaceState | undefined
let ownership: WorkspaceOwnership | undefined
let pending: (() => void) | undefined
let scheduledTimers = 0
let cancelledTimers = 0
let ignoredStaleCallbacks = 0
let actions = 0
let composer: SolidNode | undefined
let typedPrompts = 0
const recorder = new SessionRecorder(native ? directory : undefined)

// Fixture-owned reply clock: at most one timer, cancellation is observable.
const schedule: ReplyScheduler = (callback) => {
  assert.equal(pending, undefined, 'The workspace must never own two reply timers')
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
let lastRound = -1

async function sample(round: number) {
  // Sparse measurement only: collect, then count observed live cells.
  await Bun.sleep(0)
  Bun.gc(true)
  await Bun.sleep(0)
  const statistics = heapStats()
  const hostProcess = processSample(hostPid)
  const elapsedMs = performance.now() - started
  lastSample = elapsedMs
  const row = recorder.record({
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
    localWork: controller?.ownership,
    ...(session?.census ? { objectTypeCounts: statistics.objectTypeCounts } : {}),
  })
  if (session?.census) writeStringCensus(directory!, round)
  // A long session keeps its samples on disk, not in the heap it samples.
  if (session) lastRound = round
  else samples.push(row)
}

try {
  const window = await app.openWindow({
    title: TITLE,
    width: 1120,
    height: 760,
  })
  root = render(
    () => (
      <Workspace
        schedule={schedule}
        onController={(owned) => {
          controller = owned
        }}
        onComposer={(node) => {
          composer = node
        }}
        onDispose={(state, released) => {
          disposedState = state
          ownership = released
        }}
      />
    ),
    window,
    { style: { width: 'fill', height: 'fill' } }
  )
  await root.ready
  await root.flush()
  hostPid = native ? ownedHost(executable) : undefined
  if (native && (platform() === 'linux' || platform() === 'darwin'))
    assert(hostPid, 'The owned native host must be observable')
  const workspace = controller!
  assert(workspace, 'The component must expose its controller to this fixture')
  const initial = workspace.state
  const baseline = {
    rootNodes: root.diagnostics.nodes,
    rootListeners: root.diagnostics.listeners,
    application: app.diagnostics,
  }

  const input = session?.osInput
    ? await openOsInput(TITLE, hostPid!, executable, [1120, 760])
    : undefined

  async function act(action: () => void) {
    const begun = performance.now()
    action()
    actions++
    await root!.flush()
    assert.equal(root!.diagnostics.pending, false)
    recorder.ack(performance.now() - begun)
  }

  async function tick(count: number) {
    for (let index = 0; index < count; index++) {
      if (session?.paceMs) await Bun.sleep(session.paceMs)
      const callback = pending
      assert(callback, 'A streaming reply must own one scheduled update')
      pending = undefined
      await act(callback)
    }
  }

  function shape(state: WorkspaceState) {
    return {
      conversations: state.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        draft: conversation.draft,
        messages: conversation.messages.map(({ role, body, status }) => ({ role, body, status })),
      })),
      selectedId: state.selectedId,
      theme: state.theme,
      details: state.details,
      clearConfirmation: state.clearConfirmation,
    }
  }
  const initialShape = shape(initial)
  await sample(0)

  // Real X11 typing into the focused composer, then Return through the app's
  // own key handler; the same model accounting as a controller send.
  async function typePrompt(prompt: string): Promise<boolean> {
    const typing = input!
    assert(composer, 'The mounted conversation must expose its composer')
    await focusNode(composer)
    typing.activate()
    const draft = () => selectedConversation(workspace.state).draft
    const typed = performance.now()
    typing.type(prompt)
    await waitUntil(() => draft() === prompt, 'the typed prompt in the conversation draft')
    recorder.input(performance.now() - typed)
    const sent = performance.now()
    const before = selectedConversation(workspace.state).messages.length
    typing.key('Return')
    await waitUntil(
      () => selectedConversation(workspace.state).messages.length === before + 2,
      'the Return-submitted prompt'
    )
    recorder.input(performance.now() - sent)
    await root!.flush()
    const messages = selectedConversation(workspace.state).messages
    assert.equal(messages.at(-2)?.body, prompt)
    assert.equal(messages.at(-1)?.status, 'streaming')
    assert.equal(draft(), '')
    typedPrompts++
    actions += 2
    return true
  }

  let round = 0
  while (session ? performance.now() - started < session.seconds * 1000 : round < ROUNDS) {
    round++
    const roundStarted = performance.now()
    await act(() => workspace.create())
    const id = workspace.state.selectedId
    assert.equal(workspace.state.conversations.length, initial.conversations.length + 1)
    for (let send = 0; send < SENDS_PER_ROUND; send++) {
      const prompt = `Round ${round} prompt ${send}`
      let accepted = false
      if (input && send === 0) accepted = await typePrompt(prompt)
      else
        await act(() => {
          accepted = workspace.send(prompt)
        })
      assert(accepted, 'A bounded prompt must start one reply')
      const messages = () => selectedConversation(workspace.state).messages
      switch (send % 4) {
        case 0:
        case 1:
          await tick(CHUNKS_PER_REPLY)
          assert.equal(pending, undefined)
          assert.equal(messages().at(-1)?.status, 'complete')
          assert(messages().at(-1)?.body.includes(prompt))
          break
        case 2: {
          await tick(3)
          const stale = pending
          assert(stale)
          await act(() => workspace.cancel())
          assert.equal(pending, undefined)
          // A cancelled callback that still fires must not write anything.
          const before = workspace.state
          const committed: number = root.diagnostics.commits
          await act(stale)
          assert.equal(workspace.state, before)
          assert.equal(root.diagnostics.commits, committed)
          ignoredStaleCallbacks++
          assert.equal(messages().at(-1)?.status, 'cancelled')
          break
        }
        default:
          await tick(2)
          // Switching cancels the reply and remounts the keyed conversation pane.
          await act(() => workspace.select(initial.selectedId))
          assert.equal(pending, undefined)
          await act(() => workspace.select(id))
          assert.equal(messages().at(-1)?.status, 'cancelled')
      }
      await act(() => workspace.toggleTheme())
    }
    const conversation = selectedConversation(workspace.state)
    assert.equal(conversation.id, id)
    assert.equal(conversation.messages.length, MAX_MESSAGES)
    if (input) {
      // Inside the history's scroll viewport (layout of the solid-workspace
      // scenario at this window size), which the full history overflows. The
      // scroll itself is not asserted here.
      input.wheel(560, 380, 5, 12)
      input.wheel(560, 380, 4, 12)
      await root.flush()
    }
    let rejected = true
    await act(() => {
      rejected = !workspace.send('Beyond the history limit')
    })
    assert(rejected, 'The history limit must reject another prompt')
    await act(() => workspace.requestClear())
    await act(() => workspace.dismissClear())
    assert.equal(selectedConversation(workspace.state).messages.length, MAX_MESSAGES)
    await act(() => workspace.requestClear())
    await act(() => workspace.confirmClear())
    assert.equal(selectedConversation(workspace.state).messages.length, 0)
    await act(() => workspace.toggleDetails())
    await act(() => workspace.toggleDetails())
    await act(() => workspace.close())

    // The round restored the mounted shape; ownership must not accumulate.
    assert.deepEqual(shape(workspace.state), initialShape)
    assert.equal(root.diagnostics.nodes, baseline.rootNodes, `Round ${round} native nodes`)
    assert.equal(root.diagnostics.listeners, baseline.rootListeners, `Round ${round} listeners`)
    assert.deepEqual(app.diagnostics, baseline.application, `Round ${round} public resources`)
    assert.deepEqual(workspace.ownership, {
      disposed: false,
      pendingTimers: 0,
      activeReplies: 0,
      completedReplies: (round * SENDS_PER_ROUND) / 2,
      cancelledReplies: (round * SENDS_PER_ROUND) / 2,
    })
    assert.equal(pending, undefined)
    if (session) recorder.round(performance.now() - roundStarted)
    else roundDurationsMs.push(performance.now() - roundStarted)
    if (session) {
      if (performance.now() - started - lastSample >= session.sampleSeconds * 1000)
        await sample(round)
    } else if (round % SAMPLE_EVERY === 0) await sample(round)
  }
  const rounds = round
  if (session && lastRound !== rounds) await sample(rounds)
  if (session) {
    samples.push(...recorder.readSamples())
    roundDurationsMs.push(...recorder.readRounds())
  }
  if (input) assert.equal(typedPrompts, rounds)

  const replies = rounds * SENDS_PER_ROUND
  assert.equal(scheduledTimers, (rounds * SENDS_PER_ROUND * (8 + 8 + 4 + 3)) / 4)
  assert.equal(cancelledTimers, replies / 2)
  const commits = root.diagnostics.commits
  const mutations = root.diagnostics.mutations
  await window.close()
  await root.closed
  await root.dispose()
  assert.equal(root.diagnostics.nodes, 0)
  assert.equal(root.diagnostics.listeners, 0)
  assert.deepEqual(ownership, {
    disposed: true,
    pendingTimers: 0,
    activeReplies: 0,
    completedReplies: replies / 2,
    cancelledReplies: replies / 2,
  })
  assert.deepEqual(shape(disposedState!), initialShape)
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((value) => value === 0))
  if (hostPid !== undefined) {
    let exited = false
    try {
      if (platform() === 'darwin') process.kill(hostPid, 0)
      else readFileSync(`/proc/${hostPid}/status`)
    } catch {
      exited = true
    }
    assert(exited, 'The owned native host must exit after shutdown')
  }
  const report = {
    schemaVersion: 1,
    status: 'passed',
    scenario: 'solid-workspace-soak',
    scope: !native
      ? 'Headless public adapter and owned protocol peer; no native rendering'
      : input
        ? 'Actual native host; fixture-driven component actions with native acknowledgements plus one X11-typed, Return-submitted prompt and unasserted history wheel input per round; no paint assertion'
        : 'Actual native host; fixture-driven component actions with native acknowledgements; no OS input or paint assertion',
    system: { platform: platform(), architecture: arch(), release: release() },
    bun: { version: Bun.version, revision: Bun.revision },
    rounds,
    replies,
    completedReplies: replies / 2,
    cancelledReplies: replies / 2,
    ignoredStaleCallbacks,
    scheduledTimers,
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
        ackMs: recorder.ackTotal.summary(),
        inputToStateMs: recorder.inputTotal.summary(),
        osInput: input ? { typedPrompts, ...input.counts } : null,
      },
    }),
    final: { application: app.diagnostics, localWork: ownership },
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

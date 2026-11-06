import { createApplication } from '@bun-native/core'
import { render, type RenderRoot } from '@bun-native/solid'
import { heapStats } from 'bun:jsc'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
 * leak-freedom, latency or capacity claim. There is no OS input here: the
 * separate solid-workspace scenario covers real X11 interaction and OS close.
 */
const host = process.env['BUN_NATIVE_HOST']
const peer = process.env['BUN_NATIVE_WORKSPACE_TEST_PEER']
const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const native = peer === undefined
if (native && (!host || !directory || !isAbsolute(directory)))
  throw new Error('Set BUN_NATIVE_HOST and an absolute BUN_NATIVE_DIAGNOSTICS_DIR')
const ROUNDS = native ? 60 : 3
const SAMPLE_EVERY = native ? 10 : 1
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

function hostProcess(): number | undefined {
  if (!native || platform() !== 'linux') return undefined
  const expected = realpathSync(executable)
  for (const task of readdirSync(`/proc/${process.pid}/task`)) {
    let children: string
    try {
      children = readFileSync(`/proc/${process.pid}/task/${task}/children`, 'utf8')
    } catch {
      continue
    }
    for (const child of children.split(' ').filter(Boolean)) {
      try {
        if (realpathSync(`/proc/${child}/exe`) === expected) return Number(child)
      } catch {}
    }
  }
  return undefined
}

function residentKiB(pid: number | undefined): number | null {
  if (pid === undefined) return null
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
  return match ? Number(match[1]) : null
}

const started = performance.now()
const samples: Array<Record<string, unknown>> = []
const roundDurationsMs: number[] = []
let hostPid: number | undefined

async function sample(round: number) {
  // Sparse measurement only: collect, then count observed live cells.
  await Bun.sleep(0)
  Bun.gc(true)
  await Bun.sleep(0)
  const statistics = heapStats()
  samples.push({
    round,
    elapsedMs: performance.now() - started,
    commits: root!.diagnostics.commits,
    heapSize: statistics.heapSize,
    objectCount: statistics.objectCount,
    protectedObjectCount: statistics.protectedObjectCount,
    bunRssBytes: process.memoryUsage().rss,
    hostRssKiB: residentKiB(hostPid),
  })
}

try {
  const window = await app.openWindow({
    title: 'Bun Native Solid Workspace Soak',
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
  hostPid = hostProcess()
  if (native && platform() === 'linux') assert(hostPid, 'The owned native host must be observable')
  const workspace = controller!
  assert(workspace, 'The component must expose its controller to this fixture')
  const initial = workspace.state
  const baseline = {
    rootNodes: root.diagnostics.nodes,
    rootListeners: root.diagnostics.listeners,
    application: app.diagnostics,
  }

  async function act(action: () => void) {
    action()
    actions++
    await root!.flush()
    assert.equal(root!.diagnostics.pending, false)
  }

  async function tick(count: number) {
    for (let index = 0; index < count; index++) {
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

  for (let round = 1; round <= ROUNDS; round++) {
    const roundStarted = performance.now()
    await act(() => workspace.create())
    const id = workspace.state.selectedId
    assert.equal(workspace.state.conversations.length, initial.conversations.length + 1)
    for (let send = 0; send < SENDS_PER_ROUND; send++) {
      const prompt = `Round ${round} prompt ${send}`
      let accepted = false
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
    roundDurationsMs.push(performance.now() - roundStarted)
    if (round % SAMPLE_EVERY === 0) await sample(round)
  }

  const replies = ROUNDS * SENDS_PER_ROUND
  assert.equal(scheduledTimers, (ROUNDS * SENDS_PER_ROUND * (8 + 8 + 4 + 3)) / 4)
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
      readFileSync(`/proc/${hostPid}/status`)
    } catch {
      exited = true
    }
    assert(exited, 'The owned native host must exit after shutdown')
  }
  const report = {
    schemaVersion: 1,
    status: 'passed',
    scenario: 'solid-workspace-soak',
    scope: native
      ? 'Actual native host; fixture-driven component actions with native acknowledgements; no OS input or paint assertion'
      : 'Headless public adapter and owned protocol peer; no native rendering',
    system: { platform: platform(), architecture: arch(), release: release() },
    bun: { version: Bun.version, revision: Bun.revision },
    rounds: ROUNDS,
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

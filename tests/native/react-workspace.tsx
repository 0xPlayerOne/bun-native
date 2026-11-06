/** @jsxImportSource @bun-native/react */
import { createApplication, type ConfirmDialogOptions } from '@bun-native/core'
import { render, type ReactRenderRoot } from '@bun-native/react'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Workspace } from '../../examples/react-workspace/app.tsx'
import {
  PLAN_INTERVAL_MS,
  PLAN_STEPS,
  schedulePlanStep,
  type PlanScheduler,
  type WorkspaceState,
} from '../../examples/react-workspace/model.ts'

// This entry mounts the actual example. The owned X11 controller alone supplies
// input; no synthetic event injection or test-only application actions exist.
const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const executable = process.env['BUN_NATIVE_HOST']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (!directory || !isAbsolute(directory) || !executable || !nonce)
  throw new Error('Use the owned native workspace controller with a directory, host and nonce')
const outputDirectory = directory
let bytes = 0
function record(type: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ nonce, type, ...fields }) + '\n'
  bytes += Buffer.byteLength(line)
  assert(bytes <= 1_048_576, 'Workspace application evidence must remain bounded')
  appendFileSync(join(outputDirectory, 'application.jsonl'), line)
}

const app = await createApplication({ executable })
const signals = new Set<AbortSignal>()
let root: ReactRenderRoot | undefined
let state: WorkspaceState | undefined
let clicks = 0
let inputs = 0
let sequence = 0
// Observe the component's real plan timers; the default scheduler still owns them.
const timers = { scheduled: 0, fired: 0, cancelled: 0, pending: 0, afterDisposal: 0 }
let disposed = false
const schedule: PlanScheduler = (callback) => {
  timers.scheduled++
  timers.pending++
  let live = true
  const cancel = schedulePlanStep(() => {
    if (!live) return
    live = false
    timers.pending--
    timers.fired++
    if (disposed) timers.afterDisposal++
    callback()
  })
  return () => {
    if (!live) return
    live = false
    timers.pending--
    timers.cancelled++
    cancel()
  }
}
// The real window dialog backs the confirmation; this only counts its answers.
const confirmations: { options: ConfirmDialogOptions; accepted: boolean }[] = []
function changed(next: WorkspaceState) {
  state = next
  record('workspace-state', { state: next })
}

try {
  const window = await app.openWindow({
    title: 'Bun Native React Workspace',
    width: 1000,
    height: 760,
  })
  for (const type of ['click', 'input'] as const)
    window.on(
      window.root,
      type,
      (event) => {
        assert(!event.signal.aborted)
        assert(event.sequence > sequence, 'Native workspace events retain global ordering')
        sequence = event.sequence
        signals.add(event.signal)
        if (event.type === 'input') {
          inputs++
          record('input', { value: event.value, revision: event.revision, sequence })
        } else {
          clicks++
          record('click', { sequence })
        }
      },
      { capture: true }
    )
  async function confirm(options: ConfirmDialogOptions): Promise<boolean> {
    record('confirm-requested', { title: options.title, message: options.message })
    const accepted = await window.showConfirmDialog(options)
    confirmations.push({ options, accepted })
    record('confirm-answered', { accepted })
    return accepted
  }
  root = render(<Workspace onChange={changed} schedule={schedule} confirm={confirm} />, window, {
    style: { width: 'fill', height: 'fill' },
  })
  await root.ready
  record('mounted', { treeRevision: window.revision, diagnostics: root.diagnostics })
  await Promise.race([window.closed, root.closed])
  const closing = state
  await root.dispose()
  disposed = true
  // Wait past one plan interval: a leaked timer would fire after disposal.
  await Bun.sleep(PLAN_INTERVAL_MS * 2)
  assert.deepEqual(
    { pending: timers.pending, afterDisposal: timers.afterDisposal },
    { pending: 0, afterDisposal: 0 }
  )
  assert.equal(timers.scheduled, timers.fired + timers.cancelled)
  assert(timers.fired >= PLAN_STEPS.length + 3, 'Plans must stream through actual timers')
  assert(timers.cancelled >= 1, 'Closing with a pending plan must cancel its timer')
  assert.equal(closing?.plan?.status, 'streaming', 'The window must close during a plan')
  assert.equal(root.diagnostics.nodes, 0)
  assert.equal(root.diagnostics.listeners, 0)
  assert(signals.size > 0 && [...signals].every((signal) => signal.aborted))
  assert(state, 'The actual React component must publish its state')
  assert.equal(state.tasks.length, 12)
  assert.equal(state.selectedId, 1)
  assert.equal(state.nextId, 14)
  assert.equal(state.theme, 'dark')
  assert.equal(state.filter, 'all')
  assert.equal(state.query, '')
  assert(!state.tasks.some((task) => task.id === 13))
  assert.equal(state.nextPlanId, 5)
  assert.equal(state.plan?.id, 4)
  assert.equal(state.plan?.taskId, 1)
  assert.equal(state.plan?.status, 'streaming')
  assert(state.plan.steps.length >= 1 && state.plan.steps.length < PLAN_STEPS.length)
  // The scenario cancels the first deletion with Escape and accepts the second.
  assert.deepEqual(
    confirmations.map((entry) => entry.accepted),
    [false, true],
    'Deleting a task must ask once and be cancelled, then asked again and accepted'
  )
  assert(
    confirmations.every(
      (entry) => entry.options.destructive === true && entry.options.confirmLabel === 'Delete'
    )
  )
  assert(clicks >= 8 && inputs > 0, 'The workflow must receive actual native input and clicks')
  record('disposed', { diagnostics: root.diagnostics, ownership: app.diagnostics, timers })
} finally {
  try {
    await root?.dispose()
  } finally {
    await app.shutdown()
    await app.closed
  }
}
assert(Object.values(app.diagnostics).every((value) => value === 0))
writeFileSync(
  join(directory, 'application-result.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      status: 'passed',
      scenario: 'react-workspace',
      clicks,
      inputs,
      timers,
      confirmations: confirmations.map((entry) => entry.accepted),
      state,
      ownership: app.diagnostics,
    },
    null,
    2
  ) + '\n'
)

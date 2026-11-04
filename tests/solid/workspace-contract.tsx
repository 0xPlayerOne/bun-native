import { createApplication } from '@bun-native/core'
import { render } from '@bun-native/solid'
import assert from 'node:assert/strict'
import { Workspace } from '../../examples/solid-workspace/app.tsx'
import {
  REPLY_INTERVAL_MS,
  selectedConversation,
  type WorkspaceOwnership,
  type WorkspaceState,
} from '../../examples/solid-workspace/model.ts'
import { observeWindow } from '../renderers/support.ts'

// Real public adapter/IPC with synthetic peer events. This executable has no
// rendering, OS-input, native focus, geometry, or pixel acceptance claim.
const peer = process.env['BUN_NATIVE_WORKSPACE_TEST_PEER']
if (!peer) throw new Error('The contract test must provide its owned protocol peer')
const app = await createApplication({ executable: process.execPath, args: [peer] })
const actual = await app.openWindow({ title: 'Solid workspace public adapter contract' })
const { window, observations } = observeWindow(actual)
const marker = await actual.batch((batch) => {
  const node = batch.create({ kind: 'text', text: 'Contract marker' })
  batch.append(actual.root, node)
  return node
})
let state!: WorkspaceState
let disposed: WorkspaceOwnership | undefined
let changes = 0
const signals = new Set<AbortSignal>()
for (const type of ['click', 'input', 'key_down'] as const)
  actual.on(
    actual.root,
    type,
    (event) => {
      signals.add(event.signal)
    },
    { capture: true }
  )
const root = render(
  () => (
    <Workspace
      onChange={(next) => {
        state = next
        changes++
      }}
      onDispose={(next, ownership) => {
        state = next
        disposed = ownership
      }}
    />
  ),
  window,
  {
    style: { width: 'fill', height: 'fill' },
  }
)
async function until(condition: () => boolean) {
  const deadline = performance.now() + 3_000
  while (!condition()) {
    if (performance.now() >= deadline)
      throw new Error('The Solid workspace contract did not settle')
    await Bun.sleep(1)
  }
}
async function event(type: 'click' | 'input' | 'key_down', target: string, changed: () => boolean) {
  await actual.batch((batch) =>
    batch.set(marker, { kind: 'text', text: `event:${JSON.stringify({ type, target })}` })
  )
  await until(changed)
  await root.flush()
}
const selected = () => selectedConversation(state)
try {
  await root.ready
  assert.equal(state.conversations.length, 8)
  await event('click', 'New conversation', () => state.selectedId === 9)
  await event('input', 'Write a local prompt', () => selected().draft === 'native edit')
  await event('key_down', 'Write a local prompt', () => selected().messages.length === 2)
  assert.equal(actual.input(observations.inputs.at(-1)!).value, '')
  await until(() => selected().messages.at(-1)!.body.length > 0)
  await event('click', 'Cancel reply', () => selected().messages.at(-1)?.status === 'cancelled')
  const partial = selected().messages.at(-1)!.body
  assert(partial.startsWith('Local reply: '))
  assert(!partial.endsWith('was contacted.'))
  await event('click', 'Native interactions', () => state.selectedId === 2)
  await event('input', 'Write a local prompt', () => selected().draft === 'native edit')
  await event('click', 'Project brief', () => state.selectedId === 1)
  assert.equal(actual.input(observations.inputs.at(-1)!).value, '')
  await event('click', 'Native interactions', () => state.selectedId === 2)
  assert.equal(actual.input(observations.inputs.at(-1)!).value, 'native edit')
  await event('key_down', 'Write a local prompt', () => selected().messages.length === 4)
  await event('click', 'Close conversation', () => state.selectedId === 1)
  assert(!state.conversations.some((conversation) => conversation.id === 2))
  await event('click', 'Use light theme', () => state.theme === 'light')
  await event('click', 'Hide details', () => !state.details)
  await event('click', 'Clear history', () => state.clearConfirmation === 1)
  await event('click', 'Keep history', () => state.clearConfirmation === null)
  assert.equal(selected().messages.length, 12)
  await event('click', 'Clear history', () => state.clearConfirmation === 1)
  await event('click', 'Confirm clear', () => selected().messages.length === 0)
  await event('input', 'Write a local prompt', () => selected().draft === 'native edit')
  await event('key_down', 'Write a local prompt', () => selected().messages.length === 2)
  await actual.close()
  await root.closed
  assert.equal(root.diagnostics.nodes, 0)
  assert.equal(root.diagnostics.listeners, 0)
  assert.deepEqual(disposed, {
    disposed: true,
    pendingTimers: 0,
    activeReplies: 0,
    completedReplies: 0,
    cancelledReplies: 3,
  })
  assert.equal(selected().messages.at(-1)?.status, 'cancelled')
  assert(signals.size > 0 && [...signals].every((signal) => signal.aborted))
  const before = changes
  await Bun.sleep(REPLY_INTERVAL_MS + 20)
  assert.equal(changes, before)
} finally {
  try {
    await root.dispose()
  } finally {
    await app.shutdown()
    await app.closed
  }
}
assert(Object.values(app.diagnostics).every((value) => value === 0))
console.log(
  JSON.stringify({
    status: 'passed',
    scope: 'headless public adapter and owned timers',
    ownership: disposed,
    application: app.diagnostics,
  })
)

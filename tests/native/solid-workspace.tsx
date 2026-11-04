import { createApplication } from '@bun-native/core'
import { render, type RenderRoot } from '@bun-native/solid'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Workspace } from '../../examples/solid-workspace/app.tsx'
import {
  selectedConversation,
  type WorkspaceOwnership,
  type WorkspaceState,
} from '../../examples/solid-workspace/model.ts'

// The actual app is unchanged. The independent owned X11 controller alone
// supplies clicks, keys, wheel motion, resize and OS-close input.
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
let root: RenderRoot | undefined
let state: WorkspaceState | undefined
let ownership: WorkspaceOwnership | undefined
let clicks = 0
let inputs = 0
let enterKeys = 0
let sequence = 0
try {
  const window = await app.openWindow({
    title: 'Bun Native Solid Workspace',
    width: 1120,
    height: 760,
  })
  for (const type of ['click', 'input', 'key_down'] as const)
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
        } else if (event.type === 'key_down') {
          if (event.key === 'enter') enterKeys++
          record('key', { key: event.key, sequence })
        } else {
          clicks++
          record('click', { sequence })
        }
      },
      { capture: true }
    )
  root = render(
    () => (
      <Workspace
        onChange={(next) => {
          state = next
          record('workspace-state', { state: next })
        }}
        onDispose={(next, released) => {
          state = next
          ownership = released
          record('model-disposed', { state: next, ownership: released })
        }}
      />
    ),
    window,
    { style: { width: 'fill', height: 'fill' } }
  )
  await root.ready
  record('mounted', { treeRevision: window.revision, diagnostics: root.diagnostics })
  await Promise.race([window.closed, root.closed])
  await root.dispose()
  assert.equal(root.diagnostics.nodes, 0)
  assert.equal(root.diagnostics.listeners, 0)
  assert(signals.size > 0 && [...signals].every((signal) => signal.aborted))
  assert(state, 'The actual Solid component must publish its state')
  assert.deepEqual(ownership, {
    disposed: true,
    pendingTimers: 0,
    activeReplies: 0,
    completedReplies: 1,
    cancelledReplies: 3,
  })
  assert.deepEqual(
    state.conversations.map((conversation) => conversation.id),
    [1, 3, 4, 5, 6, 7, 8, 9]
  )
  assert.equal(state.selectedId, 9)
  assert.equal(state.nextConversationId, 10)
  assert.equal(state.nextMessageId, 35)
  assert.equal(state.theme, 'dark')
  assert.equal(state.details, true)
  assert.equal(state.clearConfirmation, null)
  const conversation = selectedConversation(state)
  assert.equal(conversation.draft, '')
  assert.deepEqual(
    conversation.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.body),
    ['Cancel this reply', 'Switch this reply', 'Close this reply']
  )
  assert.deepEqual(
    conversation.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.status),
    ['cancelled', 'cancelled', 'cancelled']
  )
  assert(
    clicks >= 12 && inputs > 0 && enterKeys === 4,
    'The workflow requires actual native clicks, text input and four Enter submissions'
  )
  record('disposed', { diagnostics: root.diagnostics, ownership: app.diagnostics })
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
      scenario: 'solid-workspace',
      clicks,
      inputs,
      enterKeys,
      state,
      localWork: ownership,
      ownership: app.diagnostics,
    },
    null,
    2
  ) + '\n'
)

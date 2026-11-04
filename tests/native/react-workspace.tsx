/** @jsxImportSource @bun-native/react */
import { createApplication } from '@bun-native/core'
import { render, type ReactRenderRoot } from '@bun-native/react'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Workspace } from '../../examples/react-workspace/app.tsx'
import type { WorkspaceState } from '../../examples/react-workspace/model.ts'

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
  root = render(<Workspace onChange={changed} />, window, {
    style: { width: 'fill', height: 'fill' },
  })
  await root.ready
  record('mounted', { treeRevision: window.revision, diagnostics: root.diagnostics })
  await Promise.race([window.closed, root.closed])
  await root.dispose()
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
  assert(clicks >= 8 && inputs > 0, 'The workflow must receive actual native input and clicks')
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
      scenario: 'react-workspace',
      clicks,
      inputs,
      state,
      ownership: app.diagnostics,
    },
    null,
    2
  ) + '\n'
)

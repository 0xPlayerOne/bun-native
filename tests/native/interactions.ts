import {
  createApplication,
  type NativeNode,
  type NativeUIEvent,
  type NativeEventType,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// Only the owned-window controller supplies OS input. Files sequence bounded
// application transactions while an intentionally suspended callback is pending.
const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const executable = process.env['BUN_NATIVE_HOST']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (!directory || !isAbsolute(directory) || !executable || !nonce)
  throw new Error('Explicit native diagnostics directory, host and nonce are required')
const outputDirectory = directory
const record = (type: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(
    join(outputDirectory, 'application.jsonl'),
    JSON.stringify({ nonce, type, ...fields }) + '\n'
  )
async function step(name: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!existsSync(join(outputDirectory, name))) {
    if (performance.now() >= deadline) throw new Error('Controller did not request ' + name)
    await Bun.sleep(5)
  }
}

const eventTypes = [
  'click',
  'input',
  'key_down',
  'key_up',
  'pointer_down',
  'pointer_up',
  'focus',
  'blur',
] as const satisfies readonly NativeEventType[]
const aliases = new Map<NativeNode, string>()
const signals = new Set<AbortSignal>()
const oldButtonSignals = new Set<AbortSignal>()
const inputEvents: Array<{ value: string; revision: number; sequence: number }> = []
let mode: 'normal' | 'stop' | 'immediate' | 'hold-move' | 'hold-delete' = 'normal'
let release: (() => void) | undefined
function releasePending(): void {
  const resume = release
  assert(resume, 'A callback gate must be pending')
  release = undefined
  resume()
}
let activations = 0
let traceCount = 0
let lastSequence = 0
const app = await createApplication({ executable })
assert(app.capabilities.includes('interactions_v1'))
try {
  const window = await app.openWindow({ title: 'Bun Native interactions', width: 640, height: 480 })
  const nodes = await window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: { direction: 'column', padding: 16, gap: 12, background: 0xf4f5f7 },
    })
    const heading = batch.create({
      kind: 'text',
      text: 'Shared native interactions',
      style: { height: 32, font_size: 24 },
    })
    const status = batch.create({ kind: 'text', text: 'Activations: 0', style: { height: 28 } })
    const panel = batch.create({
      kind: 'box',
      style: {
        direction: 'column',
        width: 'fill',
        height: 180,
        padding: 12,
        gap: 12,
        background: 0xe2e8f0,
      },
    })
    const button = batch.create({
      kind: 'button',
      text: 'Native action',
      style: { width: 200, height: 44 },
    })
    const input = batch.create({
      kind: 'input',
      value: 'ABCD',
      style: { width: 'fill', height: 40, font_size: 20 },
    })
    const alternate = batch.create({
      kind: 'box',
      style: { direction: 'row', width: 'fill', height: 68, padding: 12, background: 0xe4eedf },
    })
    for (const child of [heading, status, panel, alternate]) batch.append(window.root, child)
    batch.append(panel, button)
    batch.append(panel, input)
    return { status, panel, button, input, alternate }
  })
  aliases.set(window.root, 'root')
  aliases.set(nodes.panel, 'panel')
  aliases.set(nodes.alternate, 'alternate')
  aliases.set(nodes.button, 'action')
  aliases.set(nodes.input, 'input')
  function alias(node: NativeNode): string {
    const name = aliases.get(node)
    assert(name, 'Every dispatched handle belongs to the committed test tree')
    return name
  }
  function trace(event: NativeUIEvent, capture: boolean): void {
    assert.equal(event.signal.aborted, false)
    assert(event.sequence >= lastSequence, 'Callbacks retain global native event order')
    lastSequence = event.sequence
    assert(++traceCount <= 512, 'Interaction trace must stay bounded')
    signals.add(event.signal)
    if (event.currentTarget === nodes.button) oldButtonSignals.add(event.signal)
    const details: Record<string, unknown> = {}
    if (event.type === 'key_down' || event.type === 'key_up')
      Object.assign(details, { key: event.key, keyChar: event.keyChar, modifiers: event.modifiers })
    if (event.type === 'pointer_down' || event.type === 'pointer_up')
      Object.assign(details, {
        button: event.button,
        x: event.x,
        y: event.y,
        modifiers: event.modifiers,
      })
    if (event.type === 'input')
      Object.assign(details, { value: event.value, revision: event.revision })
    record('trace', {
      event: event.type,
      sequence: event.sequence,
      treeRevision: event.treeRevision,
      target: alias(event.node),
      currentTarget: alias(event.currentTarget),
      path: event.path.map(alias),
      phase: event.phase,
      capture,
      propagationStopped: event.propagationStopped,
      ...details,
    })
  }
  function bind(node: NativeNode): void {
    for (const type of eventTypes)
      for (const capture of [true, false])
        window.on(
          node,
          type,
          async (event) => {
            trace(event, capture)
            if (event.type === 'pointer_down' && capture && event.phase === 'target') {
              if (mode === 'stop') {
                event.stopPropagation()
                assert(event.propagationStopped)
                record('propagation-stopped', { policy: mode, sequence: event.sequence })
              } else if (mode === 'immediate') {
                event.stopImmediatePropagation()
                assert(event.propagationStopped)
                record('propagation-stopped', { policy: mode, sequence: event.sequence })
              }
            }
            if (
              event.type === 'pointer_down' &&
              capture &&
              event.currentTarget === window.root &&
              (mode === 'hold-move' || mode === 'hold-delete')
            ) {
              assert.equal(release, undefined)
              const gate = new Promise<void>((resolve) => {
                release = resolve
              })
              record('callback-held', {
                policy: mode,
                sequence: event.sequence,
                path: event.path.map(alias),
              })
              await gate
            }
            if (event.type === 'click' && !capture && event.phase === 'target') {
              activations += 1
              await window.batch((batch) =>
                batch.set(nodes.status, {
                  kind: 'text',
                  text: 'Activations: ' + activations,
                  style: { height: 28 },
                })
              )
              record('activation', {
                count: activations,
                target: alias(event.node),
                sequence: event.sequence,
                path: event.path.map(alias),
                eventTreeRevision: event.treeRevision,
                treeRevision: window.revision,
              })
            }
            if (event.type === 'input' && !capture && event.phase === 'target') {
              const expected = ['AxBCD', 'AYBCD'][inputEvents.length]
              assert.equal(event.value, expected)
              assert.equal(event.revision, inputEvents.length + 1)
              inputEvents.push({
                value: event.value,
                revision: event.revision,
                sequence: event.sequence,
              })
              record('input', {
                value: event.value,
                revision: event.revision,
                sequence: event.sequence,
              })
            }
          },
          { capture }
        )
  }
  for (const node of [window.root, nodes.panel, nodes.alternate, nodes.button, nodes.input])
    bind(node)
  record('mounted', { treeRevision: window.revision, input: window.input(nodes.input) })
  for (const policy of ['stop', 'immediate', 'hold-move'] as const) {
    await step('arm-' + policy)
    mode = policy
    record('armed-' + policy)
  }
  await step('commit-move')
  assert.equal(activations, 4)
  assert(app.diagnostics.queuedCallbacks >= 2, 'Old-path events must already be queued')
  await window.batch((batch) => batch.append(nodes.alternate, nodes.button))
  assert.deepEqual(window.input(nodes.input), { value: 'AYBCD', revision: 2 })
  record('moved', { treeRevision: window.revision, ownership: app.diagnostics })
  await step('release-move')
  mode = 'normal'
  releasePending()
  await step('arm-hold-delete')
  assert.equal(activations, 5)
  mode = 'hold-delete'
  record('armed-hold-delete')
  await step('commit-delete')
  assert(app.diagnostics.queuedCallbacks >= 2, 'Deleted-target events must already be queued')
  const replacement = await window.batch((batch) => {
    batch.remove(nodes.button)
    const fresh = batch.create({
      kind: 'button',
      text: 'Replacement action',
      style: { width: 200, height: 44 },
    })
    batch.append(nodes.alternate, fresh)
    return fresh
  })
  assert(oldButtonSignals.size > 0 && [...oldButtonSignals].every((signal) => signal.aborted))
  aliases.set(replacement, 'replacement')
  bind(replacement)
  mode = 'normal'
  releasePending()
  record('replaced', { treeRevision: window.revision, activations, ownership: app.diagnostics })
  await step('complete')
  assert.equal(activations, 6, 'Queued deleted clicks must not reach the replacement')
  assert.deepEqual(window.input(nodes.input), { value: 'AYBCD', revision: 2 })
  assert.deepEqual(
    inputEvents.map(({ value, revision }) => ({ value, revision })),
    [
      { value: 'AxBCD', revision: 1 },
      { value: 'AYBCD', revision: 2 },
    ]
  )
  record('complete', {
    treeRevision: window.revision,
    activations,
    input: window.input(nodes.input),
  })
  await window.closed
} finally {
  release?.()
  await app.shutdown()
  await app.closed
}
assert([...signals].every((signal) => signal.aborted))
assert(Object.values(app.diagnostics).every((count) => count === 0))
writeFileSync(
  join(directory, 'application-result.json'),
  JSON.stringify({
    status: 'passed',
    scenario: 'interactions',
    activations,
    inputEvents,
    traceCount,
    observedRegistrationSignalsRevoked: signals.size,
    ownership: app.diagnostics,
  }) + '\n'
)

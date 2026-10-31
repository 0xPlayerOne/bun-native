import {
  createApplication,
  type InputState,
  type NativeNode,
  type NativeUIEvent,
} from '@bun-native/core'
import type { EventHandlers } from '@bun-native/renderer'
import { inputState, render, type RenderRoot, type SolidNode } from '@bun-native/solid'
import { createSignal, onCleanup } from 'solid-js'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { recordEvidence } from '../../examples/native-window/content.ts'

const executable = process.env['BUN_NATIVE_HOST']
const scenario = process.env['BUN_NATIVE_SOLID_EVENT_SCENARIO']
if (
  !executable ||
  !process.env['BUN_NATIVE_EVIDENCE_NONCE'] ||
  !['keyboard', 'caret', 'selection'].includes(scenario ?? '')
)
  throw new Error('Use the owned Solid interaction harness with an explicit scenario and host')

type Role = 'frame' | 'button' | 'input'
type Trace = {
  event: NativeUIEvent['type']
  role: Role
  capture: boolean
  phase: NativeUIEvent['phase']
  sequence: number
  treeRevision: number
  targetKind: string
  pathKinds: readonly string[]
  key?: string
  shift?: boolean
}
const groups = new Map<number, Trace[]>()
const identities = new Map<Role, NativeNode>()
const signals = new Set<AbortSignal>()
const expectedValue = scenario === 'caret' ? 'AxBCD' : scenario === 'selection' ? 'AYCD' : 'ABCD'
const expectedActivations = scenario === 'keyboard' ? 2 : 1
let view: RenderRoot | undefined
let input: SolidNode | undefined
let readInput!: () => InputState
let setInput!: (state: InputState) => unknown
let setCount!: (count: number) => unknown
let activations = 0
let inputChanges = 0
let traceCount = 0
let lastSequence = 0
let ownerDisposed = false
let qualified = false

function expectedRoute(first: Trace) {
  const prefix = ['frame:capture', `${first.targetKind}:target:capture`]
  if (first.event === 'key_down' && first.key === 'enter') return prefix
  const target = [...prefix, `${first.targetKind}:target:bubble`]
  return first.event === 'pointer_down' ? target : [...target, 'frame:bubble']
}

function route(rows: readonly Trace[]) {
  return rows.map((row) =>
    row.role === 'frame'
      ? `frame:${row.phase}`
      : `${row.role}:${row.phase}:${row.capture ? 'capture' : 'bubble'}`
  )
}

function hasEvent(type: NativeUIEvent['type'], target: Role, key?: string, shift?: boolean) {
  return [...groups.values()].some((rows) => {
    const row = rows[0]!
    return (
      row.event === type &&
      row.targetKind === target &&
      (key === undefined || row.key === key) &&
      (shift === undefined || row.shift === shift)
    )
  })
}

function qualify() {
  if (qualified || ownerDisposed || activations !== expectedActivations || !view || !input) return
  if (
    !hasEvent('pointer_down', 'button') ||
    !hasEvent('pointer_up', 'button') ||
    !hasEvent('focus', 'button')
  )
    return
  if (scenario === 'keyboard') {
    if (
      !hasEvent('key_down', 'button', 'enter') ||
      !hasEvent('key_up', 'button', 'enter') ||
      !hasEvent('blur', 'input')
    )
      return
  } else if (
    !hasEvent('key_down', 'button', 'tab') ||
    !hasEvent('focus', 'input') ||
    !hasEvent('blur', 'button') ||
    !hasEvent('key_down', 'input', 'home') ||
    !hasEvent('key_up', 'input', scenario === 'caret' ? 'x' : 'y') ||
    inputChanges !== 1 ||
    readInput().value !== expectedValue ||
    (scenario === 'selection' && !hasEvent('key_down', 'input', 'right', true))
  )
    return
  for (const rows of groups.values()) {
    if (rows.length < expectedRoute(rows[0]!).length) return
    assert.deepEqual(route(rows), expectedRoute(rows[0]!))
    assert(rows.every((row) => row.treeRevision === rows[0]!.treeRevision))
  }
  const revision = scenario === 'keyboard' ? 0 : 1
  assert.deepEqual(inputState(input), { value: expectedValue, revision })
  // Two counter updates, or one counter plus one derived input label. Native
  // event echoes at all four phases must never replace the input value.
  assert.equal(view.diagnostics.mutations.set, 2)
  assert.equal(view.diagnostics.mutations.create, 7)
  assert.equal(view.diagnostics.mutations.remove, 0)
  qualified = true
  const observed = {
    scenario,
    activations,
    inputChanges,
    input: inputState(input),
    traces: traceCount,
    eventGroups: groups.size,
    diagnostics: view.diagnostics,
  }
  recordEvidence({ type: 'solid-interactions-ready', ...observed })
  const type = scenario === 'keyboard' ? 'click' : 'input'
  const actual = [...groups.values()].findLast((rows) => rows[0]!.event === type)![0]!
  // Repeat the identified actual input/activation only after its entire route
  // and derived native state qualified; the controller still requires OS input.
  recordEvidence({
    type,
    sequence: actual.sequence,
    qualified: true,
    ...observed,
    ...(type === 'input' ? { value: expectedValue, input_revision: 1 } : {}),
  })
}

async function observe(role: Role, capture: boolean, event: NativeUIEvent) {
  if (qualified) return
  assert(!event.signal.aborted)
  assert(event.sequence >= lastSequence)
  lastSequence = event.sequence
  assert(++traceCount <= 256)
  signals.add(event.signal)
  const identity = identities.get(role)
  if (identity) assert.equal(event.currentTarget, identity)
  else identities.set(role, event.currentTarget)
  assert.equal(event.path.at(-1), event.node)
  assert(event.path.includes(event.currentTarget))
  assert(Object.isFrozen(event.path))
  assert.deepEqual(
    event.path.map((node) => node.kind),
    ['box', 'box', 'box', event.node.kind]
  )
  assert.equal(event.currentTarget.kind, role === 'frame' ? 'box' : role)
  if (role === 'button' && capture) {
    if (event.type === 'pointer_down') event.stopPropagation()
    if (event.type === 'key_down' && event.key === 'enter') event.stopImmediatePropagation()
  }
  const row: Trace = {
    event: event.type,
    role,
    capture,
    phase: event.phase,
    sequence: event.sequence,
    treeRevision: event.treeRevision,
    targetKind: event.node.kind,
    pathKinds: event.path.map((node) => node.kind),
  }
  const details: Record<string, unknown> = {}
  if (event.type === 'key_down' || event.type === 'key_up') {
    row.key = event.key
    row.shift = event.modifiers.shift
    Object.assign(details, { key: event.key, keyChar: event.keyChar, modifiers: event.modifiers })
  } else if (event.type === 'pointer_down' || event.type === 'pointer_up') {
    assert.equal(event.button, 'left')
    assert(event.x >= 0 && event.y >= 0)
    Object.assign(details, {
      button: event.button,
      x: event.x,
      y: event.y,
      modifiers: event.modifiers,
    })
  } else if (event.type === 'input') {
    assert.equal(event.value, expectedValue)
    assert.equal(event.revision, 1)
    // Every ancestor/target phase stores its actual branded observation. The
    // native widget remains authoritative and its revision must stay one.
    setInput(event)
    if (role === 'input' && !capture) inputChanges++
    Object.assign(details, { value: event.value, revision: event.revision })
  }
  const rows = groups.get(event.sequence) ?? []
  rows.push(row)
  groups.set(event.sequence, rows)
  recordEvidence({
    type: 'solid-interaction',
    ...row,
    propagationStopped: event.propagationStopped,
    ...details,
  })
  if (event.type === 'click' && role === 'button' && !capture) setCount(++activations)
  await view!.flush()
  qualify()
}

function handlers(role: Role): EventHandlers {
  return {
    onClickCapture: (event) => observe(role, true, event),
    onClick: (event) => observe(role, false, event),
    onInputCapture: (event) => observe(role, true, event),
    onInput: (event) => observe(role, false, event),
    onKeyDownCapture: (event) => observe(role, true, event),
    onKeyDown: (event) => observe(role, false, event),
    onKeyUpCapture: (event) => observe(role, true, event),
    onKeyUp: (event) => observe(role, false, event),
    onPointerDownCapture: (event) => observe(role, true, event),
    onPointerDown: (event) => observe(role, false, event),
    onPointerUpCapture: (event) => observe(role, true, event),
    onPointerUp: (event) => observe(role, false, event),
    onFocusCapture: (event) => observe(role, true, event),
    onFocus: (event) => observe(role, false, event),
    onBlurCapture: (event) => observe(role, true, event),
    onBlur: (event) => observe(role, false, event),
  }
}

const application = await createApplication({ executable: resolve(executable) })
try {
  const window = await application.openWindow({
    title: 'Bun Native Solid Events',
    width: 640,
    height: 420,
  })
  view = render(() => {
    const [count, updateCount] = createSignal(0)
    const [value, updateInput] = createSignal<InputState>({ value: 'ABCD', revision: 0 })
    setCount = updateCount
    setInput = updateInput
    readInput = value
    onCleanup(() => {
      ownerDisposed = true
    })
    return (
      <box {...handlers('frame')} style={{ direction: 'column', padding: 24, gap: 12 }}>
        <text text="Solid native event properties" style={{ height: 32, font_size: 24 }} />
        <text text={`Clicks: ${count()}`} style={{ height: 28 }} />
        <button {...handlers('button')} text="Native action" style={{ width: 200, height: 44 }} />
        <input
          {...handlers('input')}
          ref={(node) => {
            input = node
          }}
          value={value()}
          style={{ width: 'fill', height: 40, font_size: 20 }}
        />
        <text text={`Input: ${value().value}`} style={{ height: 28 }} />
      </box>
    )
  }, window)
  await view.ready
  recordEvidence({ type: 'solid-interactions-mounted', scenario, diagnostics: view.diagnostics })
  await window.closed
  await view.dispose()
  assert(qualified, 'The actual native interaction scenario did not qualify')
  assert(ownerDisposed)
  assert.equal(view.diagnostics.nodes, 0)
  assert.equal(view.diagnostics.listeners, 0)
  assert(signals.size > 0 && [...signals].every((signal) => signal.aborted))
  recordEvidence({
    type: 'solid-interactions-complete',
    scenario,
    activations,
    inputChanges,
    traceCount,
    observedSignalsRevoked: signals.size,
    ownerDisposed,
    diagnostics: view.diagnostics,
  })
  recordEvidence({ type: 'closed' })
} finally {
  await view?.dispose()
  await application.shutdown()
  await application.closed
}
assert(Object.values(application.diagnostics).every((count) => count === 0))
recordEvidence({ type: 'solid-interactions-ownership', ownership: application.diagnostics })

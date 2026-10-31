import {
  createApplication,
  type InputState,
  type NativeNode,
  type NativeUIEvent,
  type NativeWindow,
} from '@bun-native/core'
import type { EventHandlers, RenderRoot } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { recordEvidence } from '../../examples/native-window/content.ts'

type Role = 'frame' | 'button' | 'input'
interface MountedView {
  root: RenderRoot
  input(): InputState
  value(): InputState
  setInput(value: InputState): void
  setCount(count: number): void
  disposed(): boolean
}

/** One actual native route/input/ownership oracle for framework view adapters. */
export async function runRendererInteractions(
  framework: 'React' | 'Solid',
  mount: (window: NativeWindow, handlers: (role: Role) => EventHandlers) => MountedView
): Promise<void> {
  const record = (event: Record<string, unknown>) => recordEvidence({ framework, ...event })
  const executable = process.env['BUN_NATIVE_HOST']
  const scenario = process.env['BUN_NATIVE_RENDERER_EVENT_SCENARIO']
  if (
    !executable ||
    !process.env['BUN_NATIVE_EVIDENCE_NONCE'] ||
    !['keyboard', 'caret', 'selection'].includes(scenario ?? '')
  )
    throw new Error('Use the owned renderer interaction harness with an explicit scenario and host')

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
  let view: MountedView | undefined
  let activations = 0
  let inputChanges = 0
  let traceCount = 0
  let lastSequence = 0
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
    if (qualified || !view || view.disposed() || activations !== expectedActivations) return
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
      view.value().value !== expectedValue ||
      (scenario === 'selection' && !hasEvent('key_down', 'input', 'right', true))
    )
      return
    for (const rows of groups.values()) {
      if (rows.length < expectedRoute(rows[0]!).length) return
      assert.deepEqual(route(rows), expectedRoute(rows[0]!))
      assert(rows.every((row) => row.treeRevision === rows[0]!.treeRevision))
    }
    const revision = scenario === 'keyboard' ? 0 : 1
    assert.deepEqual(view.input(), { value: expectedValue, revision })
    // Two counter updates, or one counter plus one derived input label. Native
    // event echoes at all four phases must never replace the input value.
    assert.equal(view.root.diagnostics.mutations.set, 2)
    assert.equal(view.root.diagnostics.mutations.create, 7)
    assert.equal(view.root.diagnostics.mutations.remove, 0)
    qualified = true
    const observed = {
      scenario,
      activations,
      inputChanges,
      input: view.input(),
      traces: traceCount,
      eventGroups: groups.size,
      diagnostics: view.root.diagnostics,
    }
    record({ type: 'renderer-interactions-ready', ...observed })
    const type = scenario === 'keyboard' ? 'click' : 'input'
    const actual = [...groups.values()].findLast((rows) => rows[0]!.event === type)![0]!
    // Repeat the identified actual input/activation only after its entire route
    // and derived native state qualified; the controller still requires OS input.
    record({
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
      view!.setInput(event)
      if (role === 'input' && !capture) inputChanges++
      Object.assign(details, { value: event.value, revision: event.revision })
    }
    const rows = groups.get(event.sequence) ?? []
    rows.push(row)
    groups.set(event.sequence, rows)
    record({
      type: 'renderer-interaction',
      ...row,
      propagationStopped: event.propagationStopped,
      ...details,
    })
    if (event.type === 'click' && role === 'button' && !capture) view!.setCount(++activations)
    await view!.root.flush()
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
  assert(application.capabilities.includes('interactions_v1'))
  try {
    const window = await application.openWindow({
      title: `Bun Native ${framework} Events`,
      width: 640,
      height: 420,
    })
    view = mount(window, handlers)
    await view.root.ready
    record({ type: 'renderer-interactions-mounted', scenario, diagnostics: view.root.diagnostics })
    await window.closed
    await view.root.dispose()
    assert(qualified, 'The actual native interaction scenario did not qualify')
    assert(view.disposed(), 'The framework owner must dispose on OS close')
    assert.equal(view.root.diagnostics.nodes, 0)
    assert.equal(view.root.diagnostics.listeners, 0)
    assert(signals.size > 0 && [...signals].every((signal) => signal.aborted))
    record({
      type: 'renderer-interactions-complete',
      scenario,
      activations,
      inputChanges,
      traceCount,
      observedSignalsRevoked: signals.size,
      ownerDisposed: view.disposed(),
      diagnostics: view.root.diagnostics,
    })
    record({ type: 'closed' })
  } finally {
    await view?.root.dispose()
    await application.shutdown()
    await application.closed
  }
  assert(Object.values(application.diagnostics).every((count) => count === 0))
  record({ type: 'renderer-interactions-ownership', ownership: application.diagnostics })
}

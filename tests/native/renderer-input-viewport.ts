import {
  createApplication,
  type InputState,
  type NativeNode,
  type NativeUIEvent,
  type NativeWindow,
  type Style,
} from '@bun-native/core'
import type { EventHandlers, RenderRoot } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const INITIAL_VALUE = ' '.repeat(96) + 'TAIL'
export interface ViewportState {
  input: InputState
  edits: number
  restyled: boolean
}
export const initialState = (): ViewportState => ({
  input: { value: INITIAL_VALUE, revision: 0 },
  edits: 0,
  restyled: false,
})
export const frameStyle: Style = {
  direction: 'column',
  width: 'fill',
  height: 'fill',
  padding: 24,
  gap: 12,
  background: 0x101820,
}
export const inputStyle = (restyled: boolean) =>
  ({
    width: 0,
    min_width: 80,
    flex_grow: 1,
    height: 56,
    font_size: restyled ? 24 : 20,
    background: restyled ? 0x202c38 : 0x182430,
    color: 0xffffff,
    overflow: 'visible',
  }) satisfies Style
export const statusText = (state: ViewportState): string =>
  `Mode: ${state.restyled ? 'restyled' : 'original'}; edits: ${state.edits}`

interface MountedViewport {
  root: RenderRoot
  input(): InputState
  state(): ViewportState
  setState(state: ViewportState): void
  disposed(): boolean
}

/** Both real adapters consume the same public input, OS actions and lifetime oracle. */
export async function runInputViewport(
  framework: 'React' | 'Solid',
  mount: (window: NativeWindow, handlers: EventHandlers) => MountedViewport
): Promise<void> {
  const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
  const executable = process.env['BUN_NATIVE_HOST']
  const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
  const scenario = `${framework.toLowerCase()}-input-viewport`
  if (
    !directory ||
    !isAbsolute(directory) ||
    !executable ||
    !nonce ||
    process.env['BUN_NATIVE_DIAGNOSTICS_SCENARIO'] !== scenario ||
    process.env['BUN_NATIVE_INPUT_VIEWPORT_TRACE'] !== '1'
  )
    throw new Error(
      'Use the owned native input viewport controller with its explicit host and nonce'
    )
  let bytes = 0
  function record(type: string, fields: Record<string, unknown> = {}) {
    const line = JSON.stringify({ nonce, type, framework, ...fields }) + '\n'
    bytes += Buffer.byteLength(line)
    assert(bytes <= 1_048_576, 'Input viewport evidence must remain bounded')
    appendFileSync(join(directory!, 'application.jsonl'), line)
  }

  const app = await createApplication({ executable })
  let view: MountedViewport | undefined
  let window: NativeWindow
  let identity: NativeNode | undefined
  let sequence = 0
  let events = 0
  let restyles = 0
  let edits = 0
  const signals = new Set<AbortSignal>()
  const keys = new Set<string>()
  const expectedEdits = [
    INITIAL_VALUE + 'x',
    INITIAL_VALUE + 'Y',
    '',
    's',
    'sh',
    'sho',
    'shor',
    'short',
  ]
  async function observe(event: NativeUIEvent) {
    assert(view && !view.disposed(), 'A native callback requires its mounted owner')
    assert(!event.signal.aborted)
    assert(event.sequence > sequence, 'Native viewport event sequences strictly increase')
    sequence = event.sequence
    assert(++events <= 128)
    signals.add(event.signal)
    assert.equal(event.node.kind, 'input')
    assert.equal(event.currentTarget, event.node)
    assert.deepEqual(
      event.path.map((node) => node.kind),
      ['box', 'box', 'box', 'box', 'input']
    )
    if (identity) assert.equal(event.node, identity, 'Resize/restyle retain the same native input')
    else identity = event.node
    const details: Record<string, unknown> = {}
    if (event.type === 'input') {
      assert.equal(event.value, expectedEdits[edits])
      assert.equal(event.revision, edits + 1 + restyles)
      edits++
      // Echo the actual branded observation. It must not become a native Set.
      view.setState({ ...view.state(), input: event, edits })
      Object.assign(details, { value: event.value, revision: event.revision })
    } else if (event.type === 'key_down' || event.type === 'key_up') {
      keys.add(`${event.type}:${event.key}:${event.modifiers.shift}`)
      Object.assign(details, { key: event.key, modifiers: event.modifiers })
      if (event.type === 'key_down' && event.key === 'f6') {
        assert.equal(restyles, 0)
        assert.equal(edits, 2)
        restyles++
        view.setState({ ...view.state(), restyled: true })
      }
    } else if (event.type === 'pointer_down' || event.type === 'pointer_up') {
      assert.equal(event.button, 'left')
      Object.assign(details, { x: event.x, y: event.y, button: event.button })
    }
    record('viewport-event', {
      event: event.type,
      sequence,
      treeRevision: event.treeRevision,
      target: 'input',
      ...details,
    })
    try {
      await view.root.flush()
    } catch (error) {
      if (event.signal.aborted) return
      throw error
    }
    if (event.signal.aborted || view.disposed()) return
    record('viewport-state', {
      state: { ...view.state(), input: view.input() },
      sequence,
      treeRevision: window.revision,
    })
  }
  try {
    window = await app.openWindow({
      title: `Bun Native ${framework} Input Viewport`,
      width: 760,
      height: 400,
    })
    view = mount(window, {
      onInput: observe,
      onKeyDown: observe,
      onKeyUp: observe,
      onPointerDown: observe,
      onPointerUp: observe,
      onFocus: observe,
      onBlur: observe,
    })
    await view.root.ready
    record('viewport-state', { state: initialState(), sequence, treeRevision: window.revision })
    record('mounted', { treeRevision: window.revision, diagnostics: view.root.diagnostics })
    await Promise.race([window.closed, view.root.closed])
    await view.root.dispose()
    assert(view.disposed(), 'OS close disposes the framework owner and revokes the native ref')
    assert.equal(edits, expectedEdits.length)
    assert.equal(restyles, 1)
    assert.equal(view.state().input.value, 'short')
    assert.equal(view.state().input.revision, 9)
    assert.equal(view.state().edits, 8)
    assert.equal(view.state().restyled, true)
    for (const key of [
      'home:false',
      'end:false',
      'left:false',
      'left:true',
      'f6:false',
      'backspace:false',
    ])
      assert(keys.has(`key_down:${key}`), `The owned OS controller must deliver ${key}`)
    assert.equal(view.root.diagnostics.nodes, 0)
    assert.equal(view.root.diagnostics.listeners, 0)
    assert(signals.size > 0 && [...signals].every((signal) => signal.aborted))
    record('disposed', { diagnostics: view.root.diagnostics, observedSignalsRevoked: signals.size })
  } finally {
    try {
      await view?.root.dispose()
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
        scenario,
        framework,
        edits,
        restyles,
        events,
        ownership: app.diagnostics,
      },
      null,
      2
    ) + '\n'
  )
}

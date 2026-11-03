/** @jsxImportSource @bun-native/react */
import { describe, expect, test } from 'bun:test'
import type {
  InputState,
  KeyEvent,
  NativeEventType,
  NativeNode,
  NativeUIEvent,
  NativeWindow,
} from '@bun-native/core'
import { inputState, render, type NativeRef } from '@bun-native/react'
import { createRef, useState } from 'react'
import { withApp } from '../renderers/support.ts'
import { until } from './support.ts'

// These events traverse real Bun subprocess IPC and the public dispatcher.
// The peer emits deterministic protocol records; this is not OS input evidence.
async function eventMarker(window: NativeWindow) {
  return window.batch((batch) => {
    const marker = batch.create({ kind: 'text', text: 'Event fixture' })
    batch.append(window.root, marker)
    return marker
  })
}

function trigger(window: NativeWindow, marker: NativeNode<'text'>, type: NativeEventType) {
  return window.batch((batch) =>
    batch.set(marker, {
      kind: 'text',
      text: 'event:' + JSON.stringify({ type, target: type === 'input' ? 'input' : 'target' }),
    })
  )
}

describe('React uses shared native capture/target/bubble dispatch', () => {
  test('a capture state update preserves the route and publishes fresh target/bubble closures', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React native phases' })
      const marker = await eventMarker(window)
      const calls: { name: string; version: number; event: NativeUIEvent }[] = []
      function App() {
        const [version, setVersion] = useState(0)
        const record = (name: string, event: NativeUIEvent) => {
          calls.push({ name, version, event })
        }
        return (
          <box
            onClickCapture={(event) => {
              record('ancestor capture', event)
              setVersion((previous) => previous + 1)
            }}
            onClick={(event) => record('ancestor bubble', event)}
          >
            <button
              onClickCapture={(event) => record('target capture', event)}
              onClick={(event) => record('target bubble', event)}
            >
              target
            </button>
            <text>Version: {version}</text>
          </box>
        )
      }
      const root = render(<App />, window)
      try {
        await root.ready
        const before = root.diagnostics
        const nativeRevision = window.revision + 1 // The peer emits after its marker batch.
        await trigger(window, marker, 'click')
        await until(() => calls.length === 4 && app.diagnostics.activeCallbacks === 0)
        await root.flush()
        expect(calls.map(({ name, version }) => ({ name, version }))).toEqual([
          { name: 'ancestor capture', version: 0 },
          { name: 'target capture', version: 1 },
          { name: 'target bubble', version: 1 },
          { name: 'ancestor bubble', version: 1 },
        ])
        expect(calls.map(({ event }) => event.phase)).toEqual([
          'capture',
          'target',
          'target',
          'bubble',
        ])
        const target = calls[0]!.event.node
        const path = calls[0]!.event.path
        expect(path.map((node) => node.kind)).toEqual(['box', 'box', 'box', 'button'])
        expect(path[0]).toBe(window.root)
        expect(path.at(-1)).toBe(target)
        for (const { event } of calls) {
          expect(event.node).toBe(target)
          expect(event.path).toBe(path)
          expect(event.sequence).toBe(1)
          expect(event.treeRevision).toBe(nativeRevision)
          expect(event.signal.aborted).toBe(false)
          expect(Object.isFrozen(event)).toBe(true)
        }
        expect(calls.map(({ event }) => event.currentTarget)).toEqual([
          path[2]!,
          target,
          target,
          path[2]!,
        ])
        expect(root.diagnostics.mutations.set - before.mutations.set).toBe(1)
        expect(root.diagnostics.listeners).toBe(4)
      } finally {
        await root.dispose()
      }
      expect(calls.every(({ event }) => event.signal.aborted)).toBe(true)
      expect(app.diagnostics.callbacks).toBe(0)
    }, 'events-peer.ts'))

  test('all native event families retain their typed payload through React phase wrappers', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React native event families' })
      const marker = await eventMarker(window)
      const calls: NativeUIEvent[] = []
      const record = (event: NativeUIEvent) => {
        calls.push(event)
      }
      const root = render(
        <box
          onClickCapture={record}
          onClick={record}
          onInputCapture={record}
          onInput={record}
          onKeyDownCapture={record}
          onKeyDown={record}
          onKeyUpCapture={record}
          onKeyUp={record}
          onPointerDownCapture={record}
          onPointerDown={record}
          onPointerUpCapture={record}
          onPointerUp={record}
          onFocusCapture={record}
          onFocus={record}
          onBlurCapture={record}
          onBlur={record}
        >
          <button
            onClick={record}
            onKeyDown={record}
            onKeyUp={record}
            onPointerDown={record}
            onPointerUp={record}
            onFocus={record}
            onBlur={record}
          >
            target
          </button>
          <input value="" placeholder="input" onInput={record} />
        </box>,
        window
      )
      try {
        await root.ready
        const types = [
          'click',
          'input',
          'key_down',
          'key_up',
          'pointer_down',
          'pointer_up',
          'focus',
          'blur',
        ] as const
        for (const [index, type] of types.entries()) {
          const start = calls.length
          await trigger(window, marker, type)
          await until(() => calls.length === start + 3 && app.diagnostics.activeCallbacks === 0)
          const received = calls.slice(start)
          expect(received.map((event) => event.phase)).toEqual(['capture', 'target', 'bubble'])
          for (const event of received) {
            expect(event.type).toBe(type)
            expect(event.sequence).toBe(index + 1)
            expect(event.node.kind).toBe(type === 'input' ? 'input' : 'button')
            if (event.type === 'key_down' || event.type === 'key_up') {
              expect(event.key).toBe('enter')
              expect(event.keyChar).toBe('\r')
            } else if (event.type === 'pointer_down' || event.type === 'pointer_up') {
              expect([event.button, event.x, event.y]).toEqual(['right', 12.5, -4.25])
            } else if (event.type === 'input') {
              expect({ value: event.value, revision: event.revision }).toEqual({
                value: 'native edit',
                revision: 1,
              })
            }
            if ('modifiers' in event) {
              expect(event.modifiers).toEqual({
                control: true,
                alt: false,
                shift: true,
                platform: false,
                function: false,
              })
              expect(Object.isFrozen(event.modifiers)).toBe(true)
            }
          }
        }
        expect(app.diagnostics.callbacks).toBe(24)
      } finally {
        await root.dispose()
      }
      expect(calls.every((event) => event.signal.aborted)).toBe(true)
    }, 'events-peer.ts'))

  test.each(['stopPropagation', 'stopImmediatePropagation'] as const)(
    '%s preserves the core target-phase semantics',
    (stop) =>
      withApp(async (app) => {
        const window = await app.openWindow({ title: 'React propagation control' })
        const marker = await eventMarker(window)
        const calls: string[] = []
        const root = render(
          <box
            onClickCapture={() => {
              calls.push('ancestor capture')
            }}
            onClick={() => {
              calls.push('ancestor bubble')
            }}
          >
            <button
              onClickCapture={(event) => {
                calls.push('target capture')
                event[stop]()
                expect(event.propagationStopped).toBe(true)
              }}
              onClick={() => {
                calls.push('target bubble')
              }}
            >
              target
            </button>
          </box>,
          window
        )
        try {
          await root.ready
          await trigger(window, marker, 'click')
          await until(() => calls.length >= 2 && app.diagnostics.activeCallbacks === 0)
          expect(calls).toEqual(
            stop === 'stopPropagation'
              ? ['ancestor capture', 'target capture', 'target bubble']
              : ['ancestor capture', 'target capture']
          )
          expect(app.diagnostics.callbacks).toBe(4)
        } finally {
          await root.dispose()
        }
      }, 'events-peer.ts')
  )

  test('removing capture preserves an active target callback and queued latest closure', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React independent phase lifetime' })
      const marker = await eventMarker(window)
      let update!: (state: { capture: boolean; version: number }) => void
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const captured: KeyEvent<'key_down'>[] = []
      const received: { event: KeyEvent<'key_down'>; version: number }[] = []
      function App() {
        const [state, setState] = useState({ capture: true, version: 0 })
        update = setState
        return (
          <box
            {...(state.capture
              ? {
                  onKeyDownCapture: (event: KeyEvent<'key_down'>) => {
                    captured.push(event)
                  },
                }
              : {})}
          >
            <button
              onKeyDown={async (event) => {
                received.push({ event, version: state.version })
                if (received.length === 1) await gate
              }}
            >
              target
            </button>
            <text>Version: {state.version}</text>
          </box>
        )
      }
      const root = render(<App />, window)
      try {
        await root.ready
        await trigger(window, marker, 'key_down')
        await until(() => received.length === 1)
        await trigger(window, marker, 'key_down')
        await until(() => app.diagnostics.queuedCallbacks === 1)
        update({ capture: false, version: 1 })
        await root.flush()
        expect(captured[0]!.signal.aborted).toBe(true)
        expect(received[0]!.event.signal.aborted).toBe(false)
        expect(root.diagnostics.listeners).toBe(1)
        release()
        await until(() => received.length === 2 && app.diagnostics.activeCallbacks === 0)
        expect(captured).toHaveLength(1)
        expect(received.map(({ event, version }) => [event.sequence, version])).toEqual([
          [1, 0],
          [2, 1],
        ])
      } finally {
        release()
        await root.dispose()
      }
      expect(received.every(({ event }) => event.signal.aborted)).toBe(true)
    }, 'events-peer.ts'))

  test('an ancestor input observation updates React state without echoing native text', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React captured input state' })
      const marker = await eventMarker(window)
      const reference = createRef<NativeRef>()
      const phases: string[] = []
      function App() {
        const [value, setValue] = useState<InputState>({ value: '', revision: 0 })
        return (
          <box
            onInputCapture={(event) => {
              phases.push(event.phase)
              expect(event.currentTarget.kind).toBe('box')
              expect(event.node.kind).toBe('input')
              setValue(event)
            }}
          >
            <input ref={reference} value={value} placeholder="input" />
            <text>
              Value: {value.value} @ {value.revision}
            </text>
          </box>
        )
      }
      const root = render(<App />, window)
      try {
        await root.ready
        const before = root.diagnostics
        for (const revision of [1, 2]) {
          await trigger(window, marker, 'input')
          await until(() => phases.length === revision && app.diagnostics.activeCallbacks === 0)
          await root.flush()
          expect(inputState(reference.current!)).toEqual({ value: 'native edit', revision })
        }
        expect(phases).toEqual(['capture', 'capture'])
        // Exactly the two label updates. Replacing input text would increment
        // both the native input revision and mutation count again.
        expect(root.diagnostics.mutations.set - before.mutations.set).toBe(2)
        expect(root.diagnostics.listeners).toBe(1)
      } finally {
        await root.dispose()
      }
      expect(reference.current).toBeNull()
    }, 'events-peer.ts'))
})

/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  createApplication,
  type NativeApplication,
  type NativeProcess,
  type ProcessEvent,
} from '@bun-native/core'
import { render } from '@bun-native/react'
import { Workspace } from '../../examples/react-workspace/app.tsx'
import { TerminalSession } from '../../examples/shared/terminal.ts'
import { until } from './support.ts'

// The overlay peer advertises scroll anchors and input states, which the panel uses, and
// routes deterministic events by button text or input placeholder.
async function withPeer(run: (app: NativeApplication) => Promise<void>) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, '../core/overlay-peer.ts'), '--overlays', '--input-states'],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0 })
}

type Listener = (event: ProcessEvent) => void | Promise<void>

/** An owned shell stand-in: records writes and releases, emits output on demand. */
function fakeShells() {
  type Shell = { writes: string[]; released: number; emit: (text: string) => unknown }
  const shells: Shell[] = []
  const session = new TerminalSession(async (listener: Listener) => {
    let sequence = 0
    const shell: Shell = { writes: [], released: 0, emit: () => undefined }
    const handle: NativeProcess = {
      executable: 'shell',
      terminal: true,
      get active() {
        return shell.released === 0
      },
      exit: undefined,
      write: async (bytes) => {
        shell.writes.push(new TextDecoder().decode(bytes))
      },
      closeInput: async () => {},
      resize: async () => {},
      signal: async () => {},
      release: async () => {
        shell.released++
      },
    }
    const emit = (text: string) =>
      listener({
        type: 'process_output',
        sequence: ++sequence,
        process: handle,
        stream: 'terminal',
        bytes: new TextEncoder().encode(text),
        signal: new AbortController().signal,
      })
    shell.emit = emit
    shells.push(shell)
    return handle
  })
  return { session, shells }
}

test('the React workspace drives the shared terminal session and releases nothing it does not own', () =>
  withPeer(async (app) => {
    const window = await app.openWindow({ title: 'Workspace terminal' })
    const marker = await window.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(window.root, node)
      return node
    })
    const { session, shells } = fakeShells()
    const states: string[] = []
    session.subscribe((state) => states.push(state.status))
    await session.start()
    const root = render(<Workspace terminal={session} />, window, {
      style: { width: 'fill', height: 'fill' },
    })
    const event = (type: 'click' | 'input' | 'key_down', target: string) =>
      window.batch((batch) =>
        batch.set(marker, {
          kind: 'text',
          text: `event:${JSON.stringify([{ type, target, key: 'enter' }])}`,
        })
      )
    try {
      await root.ready
      await shells[0]!.emit('hello\r\n$ ')
      await root.flush()
      expect(session.current.lines.map((line) => line.text)).toEqual(['hello'])

      // The command field sends the typed line once, with a carriage return.
      await event('input', 'Type a command and press Enter')
      await until(() => app.diagnostics.queuedCallbacks === 0)
      await root.flush()
      await event('key_down', 'Type a command and press Enter')
      await until(() => shells[0]!.writes.length === 1)
      expect(shells[0]!.writes).toEqual(['native edit\r'])

      await event('click', 'Interrupt')
      await until(() => shells[0]!.writes.length === 2)
      expect(shells[0]!.writes[1]).toBe('\u0003')

      // Restart releases the first shell and starts a second; scrollback stays, the old prompt goes.
      await event('click', 'Restart shell')
      await until(() => shells.length === 2 && session.current.status === 'running')
      expect(shells[0]!.released).toBe(1)
      await shells[1]!.emit('again\n')
      await root.flush()
      expect(session.current.lines.map((line) => line.text)).toEqual(['hello', 'again'])
    } finally {
      await root.dispose()
    }
    // Unmounting the panel unsubscribes it; the session itself belongs to the caller.
    expect(root.diagnostics.nodes).toBe(0)
    expect(shells[1]!.released).toBe(0)
    await session.release()
    expect(shells[1]!.released).toBe(1)
    expect(states.at(-1)).toBe('released')
    await window.close()
  }))

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  createApplication,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'

/** Actual public-core IPC to a headless peer; no rendering capability is simulated. */
export async function withApp(
  run: (app: NativeApplication) => Promise<void>,
  peer: 'protocol-peer.ts' | 'events-peer.ts' = 'protocol-peer.ts'
) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, '../core', peer)],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  assert.deepEqual(app.diagnostics, {
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
  })
}

/** Observe public calls without changing their native-core behavior. */
export function observeWindow(window: NativeWindow) {
  const observations = { completionReads: 0, inputs: [] as NativeNode<'input'>[] }
  const observed: NativeWindow = {
    root: window.root,
    get closed() {
      observations.completionReads += 1
      return window.closed
    },
    get revision() {
      return window.revision
    },
    batch: window.batch.bind(window),
    close: window.close.bind(window),
    displaySnapshot: window.displaySnapshot.bind(window),
    input: window.input.bind(window),
    on(node, type, listener, options) {
      if (type === 'input' && node.kind === 'input')
        observations.inputs.push(node as NativeNode<'input'>)
      return window.on(node, type, listener, options)
    },
    onClick: window.onClick.bind(window),
    onInput: window.onInput.bind(window),
  }
  return { window: observed, observations }
}

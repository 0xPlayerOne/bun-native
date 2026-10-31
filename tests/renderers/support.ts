import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  createApplication,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'

/** Actual public-core IPC to a headless peer; no rendering capability is simulated. */
export async function withApp(run: (app: NativeApplication) => Promise<void>) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, '../core/protocol-peer.ts')],
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
    input: window.input.bind(window),
    onClick: window.onClick.bind(window),
    onInput(node, listener) {
      observations.inputs.push(node)
      return window.onInput(node, listener)
    },
  }
  return { window: observed, observations }
}

// Shared helpers for the headless overlay, popup and focus tests that drive
// `overlay-peer.ts`. The peer renders nothing; it only acknowledges batches
// and emits the routed events a test asks for.
import { expect } from 'bun:test'
import {
  createApplication,
  NativeStateError,
  UnsupportedFeatureError,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import { resolve } from 'node:path'

export type PeerFlag = '--overlays' | '--keyboard' | '--popups' | '--split'

export async function withPeer(
  flags: readonly PeerFlag[],
  run: (app: NativeApplication) => Promise<void>
): Promise<void> {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'overlay-peer.ts'), ...flags],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    // allSettled keeps cleanup failures from masking the test's own error
    // without leaving never-called catch callbacks that fail the per-file
    // function coverage threshold.
    await Promise.allSettled([app.shutdown()])
    await Promise.allSettled([app.closed])
  }
  expect(app.diagnostics).toMatchObject({
    windows: 0,
    nodes: 0,
    callbacks: 0,
    activeCallbacks: 0,
  })
}

/** Poll a condition that a peer event satisfies; the bound is a failure deadline, not a delay. */
export async function waitFor(check: () => boolean, description: string): Promise<void> {
  const until = performance.now() + 2_000
  while (!check()) {
    if (performance.now() > until) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(1)
  }
}

/** Ask the peer to emit routed events after this batch's acknowledgement. */
export function trigger(
  window: NativeWindow,
  probe: NativeNode<'text'>,
  events: unknown[]
): Promise<void> {
  return window.batch((batch) =>
    batch.set(probe, { kind: 'text', text: 'event:' + JSON.stringify(events) })
  )
}

export const state = (code: string) => (error: unknown) =>
  error instanceof NativeStateError && error.code === code
export const unsupported = (feature: string) => (error: unknown) =>
  error instanceof UnsupportedFeatureError && error.feature === feature

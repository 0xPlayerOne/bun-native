import type { NativeApplication } from '@bun-native/core'
import assert from 'node:assert/strict'

export function expectWindowRootOnly(application: Pick<NativeApplication, 'diagnostics'>): void {
  assert.deepEqual(application.diagnostics, {
    windows: 1,
    nodes: 1,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
    serviceRequests: 0,
  } satisfies NativeApplication['diagnostics'])
}

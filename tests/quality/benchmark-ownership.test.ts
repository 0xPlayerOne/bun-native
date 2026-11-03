import { expect, test } from 'bun:test'
import type { NativeApplication } from '@bun-native/core'
import { expectWindowRootOnly } from '../../benchmarks/solid/workload.ts'

const windowRootOnly = {
  windows: 1,
  nodes: 1,
  callbacks: 0,
  queuedTransactions: 0,
  queuedCallbacks: 0,
  activeCallbacks: 0,
  serviceRequests: 0,
} satisfies NativeApplication['diagnostics']

test('renderer workload accepts only complete window-root ownership', () => {
  expect(() => expectWindowRootOnly({ diagnostics: windowRootOnly })).not.toThrow()
  for (const serviceRequests of [1, 8]) {
    expect(() =>
      expectWindowRootOnly({ diagnostics: { ...windowRootOnly, serviceRequests } })
    ).toThrow()
  }
})

test('renderer workload rejects reports that omit service ownership', () => {
  const diagnostics = { ...windowRootOnly }
  Reflect.deleteProperty(diagnostics, 'serviceRequests')
  expect(() => expectWindowRootOnly({ diagnostics })).toThrow()
})

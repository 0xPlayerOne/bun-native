import { expect, test } from 'bun:test'
import type { NativeApplication } from '@bun-native/core'
import { expectWindowRootOnly } from '../../benchmarks/solid/ownership.ts'

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

for (const name of Object.keys(windowRootOnly) as (keyof typeof windowRootOnly)[]) {
  test(`renderer workload rejects changed ${name} ownership`, () => {
    const diagnostics = { ...windowRootOnly, [name]: windowRootOnly[name] + 1 }
    expect(() => expectWindowRootOnly({ diagnostics })).toThrow()
  })
}

test('renderer workload rejects unrecognized ownership fields', () => {
  const diagnostics = { ...windowRootOnly, futureOwnership: 0 }
  expect(() => expectWindowRootOnly({ diagnostics })).toThrow()
})

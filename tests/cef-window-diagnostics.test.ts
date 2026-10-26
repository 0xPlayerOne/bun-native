import { test, expect } from 'bun:test'
import { parseVisibilityStage } from '../examples/cef-window-state/contract.ts'
import { acceptWindowModeReceipt } from '../benchmarks/lib/cef-window-acceptance.ts'

test('window-stage diagnostics are bounded and cannot qualify an absent authenticated visibility receipt', () => {
  const row = { sequence: 4, visibility: 'visible', stage: 'observed' }
  expect(parseVisibilityStage('BUNLY_WINDOW_STAGE:' + JSON.stringify(row))).toEqual(row)
  expect(() =>
    acceptWindowModeReceipt({ schema: 1, passed: true, failure: null, rendererStages: [row] })
  ).toThrow()
  for (const value of [
    null,
    [],
    {},
    { ...row, sequence: 16 },
    { ...row, sequence: -1 },
    { ...row, sequence: 0.5 },
    { ...row, visibility: 'intent' },
    { ...row, stage: 'success' },
    { ...row, private: 'must not retain' },
  ])
    expect(parseVisibilityStage('BUNLY_WINDOW_STAGE:' + JSON.stringify(value))).toBeNull()
  for (const input of [
    undefined,
    'BUNLY_WINDOW_STAGE:{',
    'BUNLY_WINDOW_STAGE:' + 'x'.repeat(256),
    JSON.stringify(row),
  ])
    expect(parseVisibilityStage(input)).toBeNull()
})

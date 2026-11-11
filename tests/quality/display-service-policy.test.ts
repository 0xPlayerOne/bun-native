import { expect, test } from 'bun:test'
import type { ServiceCapabilities } from '@bun-native/core'
import { assertDisplayServicePolicy } from '../native/display-service-policy.ts'

const windowDisplay = {
  availability: 'available',
  permission: 'allow',
  scope: 'owned_window',
  details: 'unavailable',
  identity: 'unavailable',
  changes: 'unavailable',
} as const satisfies ServiceCapabilities['windowDisplay']
const clipboardText = {
  availability: 'available',
  read: 'deny',
  write: 'deny',
  scope: 'owned_window',
  backend: 'x11',
} as const satisfies ServiceCapabilities['clipboardText']
const unavailable = {
  availability: 'unavailable',
  reason: 'unsupported_platform',
} as const satisfies ServiceCapabilities['clipboardText']

test('the display fixture accepts an available but separately denied clipboard', () => {
  expect(() => assertDisplayServicePolicy({ windowDisplay, clipboardText })).not.toThrow()
})

test('the display fixture accepts an explicitly unsupported clipboard backend', () => {
  expect(() =>
    assertDisplayServicePolicy({ windowDisplay, clipboardText: unavailable })
  ).not.toThrow()
})

test.each(['read', 'write'] as const)(
  'the display fixture rejects an unexpected clipboard %s grant',
  (permission) => {
    expect(() =>
      assertDisplayServicePolicy({
        windowDisplay,
        clipboardText: { ...clipboardText, [permission]: 'allow' },
      })
    ).toThrow()
  }
)

test('the display fixture rejects an absent display grant', () => {
  expect(() =>
    assertDisplayServicePolicy({
      windowDisplay: { ...windowDisplay, permission: 'deny' },
      clipboardText,
    })
  ).toThrow()
})

test.each(['availability', 'read', 'write', 'scope', 'backend'] as const)(
  'the display fixture rejects missing clipboard %s metadata',
  (field) => {
    const incomplete = { ...clipboardText }
    Reflect.deleteProperty(incomplete, field)
    expect(() => assertDisplayServicePolicy({ windowDisplay, clipboardText: incomplete })).toThrow()
  }
)

test('the display fixture rejects incomplete or extra unavailable metadata', () => {
  const incomplete = { ...unavailable }
  Reflect.deleteProperty(incomplete, 'reason')
  expect(() => assertDisplayServicePolicy({ windowDisplay, clipboardText: incomplete })).toThrow()
  const extra = { ...unavailable, read: 'allow' }
  expect(() => assertDisplayServicePolicy({ windowDisplay, clipboardText: extra })).toThrow()
})

test('the display fixture rejects unknown supported clipboard metadata', () => {
  const extra = { ...clipboardText, implicitGrant: true }
  expect(() => assertDisplayServicePolicy({ windowDisplay, clipboardText: extra })).toThrow()
})

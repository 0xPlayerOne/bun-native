/** The display fixture grants only display access, regardless of clipboard support. */
import type { ServiceCapabilities } from '@bun-native/core'
import assert from 'node:assert/strict'

export function assertDisplayServicePolicy(
  capabilities: Pick<ServiceCapabilities, 'windowDisplay' | 'clipboardText'>
): void {
  assert.deepEqual(capabilities.windowDisplay, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    // This fixture runs on Linux X11, which reports neither (#299).
    details: 'unavailable',
    changes: 'unavailable',
  })
  assert.deepEqual(
    capabilities.clipboardText,
    capabilities.clipboardText.availability === 'unavailable'
      ? { availability: 'unavailable', reason: 'unsupported_platform' }
      : {
          availability: 'available',
          read: 'deny',
          write: 'deny',
          scope: 'owned_window',
          backend: 'x11',
        }
  )
}

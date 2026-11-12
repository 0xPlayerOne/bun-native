/** The display fixture grants only display access, regardless of clipboard support. */
import type { ServiceCapabilities } from '@bun-native/core'
import assert from 'node:assert/strict'

type ClipboardBackend = Extract<
  ServiceCapabilities['clipboardText'],
  { availability: 'available' }
>['backend']

/** The clipboard backend this platform's host reports: AppKit on macOS, X11 elsewhere. */
export const platformClipboardBackend: ClipboardBackend =
  process.platform === 'darwin' ? 'appkit' : 'x11'

export function assertDisplayServicePolicy(
  capabilities: Pick<ServiceCapabilities, 'windowDisplay' | 'clipboardText'>,
  clipboardBackend: ClipboardBackend = platformClipboardBackend
): void {
  assert.deepEqual(capabilities.windowDisplay, {
    availability: 'available',
    permission: 'allow',
    scope: 'owned_window',
    // This fixture runs on Linux X11, which reports none of these (#299).
    details: 'unavailable',
    identity: 'unavailable',
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
          backend: clipboardBackend,
        }
  )
}

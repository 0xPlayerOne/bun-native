import type { ApplicationOptions, NativeApplication, NativeWindow } from '@bun-native/core'

export async function desktopServiceConsumer(app: NativeApplication, window: NativeWindow) {
  const options = {
    executable: '/absolute/prebuilt/host',
    permissions: { windowDisplay: 'allow' },
  } satisfies ApplicationOptions
  const snapshot = await window.displaySnapshot({ signal: AbortSignal.timeout(500) })
  const width: number = snapshot.bounds.width
  const scale: number = snapshot.scaleFactor
  const permission: 'allow' | 'deny' = app.serviceCapabilities.windowDisplay.permission
  const unavailable: 'unavailable' = app.serviceCapabilities.clipboardText.availability
  // @ts-expect-error The display result is immutable.
  snapshot.bounds.width = 0
  // @ts-expect-error A permission flag is an explicit policy, never a truthy value.
  const invalid: ApplicationOptions = { ...options, permissions: { windowDisplay: true } }
  // @ts-expect-error A request cannot grant itself a native capability.
  await window.displaySnapshot({ grant: true })
  // @ts-expect-error Unimplemented clipboard calls are not exported as fake APIs.
  await window.clipboard.readText()
  return { width, scale, permission, unavailable, options, invalid }
}

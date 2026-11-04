import type { ApplicationOptions, NativeApplication, NativeWindow } from '@bun-native/core'

export async function desktopServiceConsumer(app: NativeApplication, window: NativeWindow) {
  const options = {
    executable: '/absolute/prebuilt/host',
    permissions: { windowDisplay: 'allow', clipboardRead: 'allow', clipboardWrite: 'deny' },
  } satisfies ApplicationOptions
  const snapshot = await window.displaySnapshot({ signal: AbortSignal.timeout(500) })
  const width: number = snapshot.bounds.width
  const scale: number = snapshot.scaleFactor
  const permission: 'allow' | 'deny' = app.serviceCapabilities.windowDisplay.permission
  const clipboard = await window.readClipboardText({ signal: AbortSignal.timeout(500) })
  const text: string | undefined = clipboard.kind === 'text' ? clipboard.text : undefined
  await window.writeClipboardText('A deliberate copy')
  const availability: 'available' | 'unavailable' =
    app.serviceCapabilities.clipboardText.availability
  // @ts-expect-error The display result is immutable.
  snapshot.bounds.width = 0
  // @ts-expect-error A permission flag is an explicit policy, never a truthy value.
  const invalid: ApplicationOptions = { ...options, permissions: { windowDisplay: true } }
  // @ts-expect-error A request cannot grant itself a native capability.
  await window.displaySnapshot({ grant: true })
  // @ts-expect-error A native clipboard write accepts text, not arbitrary bytes.
  await window.writeClipboardText(new Uint8Array([1]))
  // @ts-expect-error Writes cannot promise cancellation or rollback of an OS side effect.
  await window.writeClipboardText('Copy', { signal: AbortSignal.abort() })
  // @ts-expect-error Read results are immutable.
  clipboard.kind = 'empty'
  return { width, scale, permission, availability, text, options, invalid }
}

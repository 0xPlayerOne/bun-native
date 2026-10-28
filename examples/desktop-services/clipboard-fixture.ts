import assert from 'node:assert/strict'
import type { PolicyScope } from '../../packages/contracts/src/index.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

type ClipboardFixtureBackend = Pick<
  CefBackend,
  | 'grantNativeCapability'
  | 'qualifyClipboardEmpty'
  | 'readClipboardText'
  | 'writeClipboardText'
  | 'clearClipboard'
>
export interface ClipboardFixtureReceipt {
  readonly status: 'executed'
  readonly deniedRead: true
  readonly deniedWrite: true
  readonly deniedClear: true
  readonly initiallyEmpty: true
  readonly oversizedRejected: true
  readonly preAbortedReadRejected: true
  readonly unicodeRoundTrip: true
  readonly emptyStringDistinct: true
  readonly utf8ByteBoundary: true
  readonly clearRemovedFormats: true
  readonly restoredEmpty: true
}
// The application and native bootstrap are separate bundles; constructor
// identity cannot establish the public error contract across that boundary.
export const hasBunlyCode = (code: string) => (error: unknown) =>
  error !== null &&
  typeof error === 'object' &&
  (error as { name?: unknown }).name === 'BunlyError' &&
  (error as { code?: unknown }).code === code

/** Contributor fixture. Its outer runner must enforce the disposable-session
 * precondition before native launch. Never invoke it from a renderer or UI action.
 * Values are compared in memory only and are never included in receipts/errors.
 */
export async function qualifyClipboardText(
  backend: ClipboardFixtureBackend,
  scope: PolicyScope,
  signal: AbortSignal
): Promise<ClipboardFixtureReceipt> {
  const options = { signal }
  await assert.rejects(backend.readClipboardText(scope, options), hasBunlyCode('PERMISSION_DENIED'))
  await backend.grantNativeCapability(scope, { name: 'clipboard-read' })
  // The text-only public API cannot restore an arbitrary image or custom format.
  // Refuse all existing contents, including an existing empty-string text format.
  assert.ok(
    await backend.qualifyClipboardEmpty(scope, options),
    'Clipboard fixture requires an empty disposable clipboard'
  )
  let restore = false,
    writeGranted = false
  try {
    // Even denied/oversized probes might mutate the clipboard if a gate regresses.
    // Run them only after the empty preflight and always restore that state.
    restore = true
    await assert.rejects(
      backend.writeClipboardText(scope, 'denied fixture', options),
      hasBunlyCode('PERMISSION_DENIED')
    )
    await assert.rejects(backend.clearClipboard(scope, options), hasBunlyCode('PERMISSION_DENIED'))
    await backend.grantNativeCapability(scope, { name: 'clipboard-write' })
    writeGranted = true
    assert.ok(
      (await backend.readClipboardText(scope, options)) === null,
      'Empty clipboard unexpectedly has accessible text'
    )
    await assert.rejects(
      backend.writeClipboardText(scope, 'x'.repeat(8193), options),
      hasBunlyCode('INVALID_ARGUMENT')
    )
    await assert.rejects(
      backend.writeClipboardText(scope, '🐙'.repeat(2049), options),
      hasBunlyCode('INVALID_ARGUMENT')
    )
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(backend.readClipboardText(scope, { signal: aborted.signal }), /abort/i)
    for (const text of ['A🐙\nλ', '', 'x'.repeat(8192), '🐙'.repeat(2048)]) {
      await backend.writeClipboardText(scope, text, options)
      assert.ok(
        (await backend.readClipboardText(scope, options)) === text,
        'Native clipboard text round trip did not match'
      )
      assert.ok(
        !(await backend.qualifyClipboardEmpty(scope, options)),
        'Written text must retain a clipboard format, including an empty string'
      )
    }
    await backend.clearClipboard(scope, options)
    assert.ok(
      (await backend.readClipboardText(scope, options)) === null,
      'Cleared clipboard unexpectedly has accessible text'
    )
    assert.ok(
      await backend.qualifyClipboardEmpty(scope, options),
      'Clipboard clear left a native format behind'
    )
  } finally {
    if (restore) {
      // The fixture's action signal may have expired. Cleanup still uses the
      // transport's existing bounded native request deadline and the live scope.
      if (!writeGranted) await backend.grantNativeCapability(scope, { name: 'clipboard-write' })
      await backend.clearClipboard(scope)
      assert.ok(
        await backend.qualifyClipboardEmpty(scope),
        'Clipboard fixture could not restore its initial empty state'
      )
    }
  }
  return Object.freeze({
    status: 'executed',
    deniedRead: true,
    deniedWrite: true,
    deniedClear: true,
    initiallyEmpty: true,
    oversizedRejected: true,
    preAbortedReadRejected: true,
    unicodeRoundTrip: true,
    emptyStringDistinct: true,
    utf8ByteBoundary: true,
    clearRemovedFormats: true,
    restoredEmpty: true,
  })
}

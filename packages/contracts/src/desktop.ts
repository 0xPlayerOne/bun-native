import { BunlyError } from './core.ts'
import type { OperationOptions } from './index.ts'

declare const policyScopeBrand: unique symbol
/** Opaque authority for one native-known document. Values cannot be reconstructed. */
export interface PolicyScope {
  readonly [policyScopeBrand]: true
}

/** Worst-case JSON escaping still fits the existing private 64 KiB frame. */
export const CLIPBOARD_TEXT_MAX_BYTES = 8192

export function validateClipboardText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > CLIPBOARD_TEXT_MAX_BYTES)
    throw new BunlyError('INVALID_ARGUMENT', 'Clipboard text exceeds the 8192-byte UTF-8 limit')
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff))
      throw new BunlyError('INVALID_ARGUMENT', 'Clipboard text requires Unicode without NUL')
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new BunlyError(
          'INVALID_ARGUMENT',
          'Clipboard text requires paired Unicode surrogates'
        )
      bytes += 4
    } else bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3
    if (bytes > CLIPBOARD_TEXT_MAX_BYTES)
      throw new BunlyError('INVALID_ARGUMENT', 'Clipboard text exceeds the 8192-byte UTF-8 limit')
  }
}

/** Optional capability facet. The captured scope must carry the relevant native grant. */
export interface ClipboardBackend {
  /** null means no accessible text representation; an empty string remains ''. */
  readClipboardText(scope: PolicyScope, options?: OperationOptions): Promise<string | null>
  writeClipboardText(scope: PolicyScope, text: string, options?: OperationOptions): Promise<void>
  /** Removes all clipboard formats. Requires the clipboard-write grant. */
  clearClipboard(scope: PolicyScope, options?: OperationOptions): Promise<void>
}

export type ApplicationQuitReason = 'requested' | 'last-window' | 'native' | 'failure'
export interface ApplicationState {
  readonly phase: 'starting' | 'running' | 'quitting' | 'closed'
  /** A local request is intent, independent of an observed native shutdown transition. */
  readonly quitRequested: boolean
  readonly quitReason: ApplicationQuitReason | null
  /** A closed native control channel does not attest that the OS process has exited. */
  readonly outcome: 'pending' | 'orderly' | 'failed'
}
export type ApplicationEvent =
  | { readonly type: 'quit-requested' }
  | { readonly type: 'quitting'; readonly reason: ApplicationQuitReason }
  | { readonly type: 'closed'; readonly outcome: 'orderly' | 'failed' }

/** Optional native lifecycle facet; no veto, relaunch or OS activation promise. */
export interface ApplicationLifecycleBackend {
  whenApplicationReady(options?: OperationOptions): Promise<ApplicationState>
  applicationState(): ApplicationState
  onApplicationEvent(
    listener: (event: ApplicationEvent) => void,
    options?: OperationOptions
  ): () => void
  quit(): Promise<void>
}

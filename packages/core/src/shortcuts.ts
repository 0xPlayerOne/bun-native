import {
  GLOBAL_SHORTCUT_KEYS,
  type GlobalShortcutKey,
  type ShortcutModifiers,
} from '@bun-native/protocol'
import { Registration } from './registration.ts'
import type { Listener } from './types.ts'

/** Layout-level key names; the native backend grabs the unshifted key that produces them. */
export type { GlobalShortcutKey }

type ShortcutFlags = {
  readonly control?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  /** Super on Linux, Command on macOS. */
  readonly platform?: boolean
}

/**
 * A key plus modifiers. At least one of `control`, `alt` or `platform` must be
 * `true`, which the type enforces; `shift` alone is not a global shortcut.
 */
export type GlobalShortcutOptions = { readonly key: GlobalShortcutKey } & (
  | (ShortcutFlags & { readonly control: true })
  | (ShortcutFlags & { readonly alt: true })
  | (ShortcutFlags & { readonly platform: true })
)

export interface GlobalShortcutEvent {
  readonly type: 'global_shortcut'
  readonly sequence: number
  readonly shortcut: NativeGlobalShortcut
  /** Aborted when the registration is removed, its window closes or the app stops. */
  readonly signal: AbortSignal
}

export interface NativeGlobalShortcut {
  readonly key: GlobalShortcutKey
  readonly modifiers: Readonly<ShortcutModifiers>
  /** False once unregistered or revoked; no later activation is delivered. */
  readonly active: boolean
  /** Idempotent. Delivery stops immediately; resolves after the OS grab is released. */
  unregister(): Promise<void>
}

const OPTION_KEYS = ['key', 'control', 'alt', 'shift', 'platform']

export function shortcutRequest(options: GlobalShortcutOptions): {
  key: GlobalShortcutKey
  modifiers: ShortcutModifiers
} {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Global shortcut options must be an object')
  if (Object.keys(options).some((key) => !OPTION_KEYS.includes(key)))
    throw new TypeError('Unknown global shortcut option')
  const key = options.key
  if (typeof key !== 'string' || !GLOBAL_SHORTCUT_KEYS.includes(key))
    throw new TypeError('Global shortcut key must be one of a-z, 0-9 or f1-f12')
  const flag = (name: 'control' | 'alt' | 'shift' | 'platform') => {
    const value = Object.hasOwn(options, name) ? options[name] : false
    if (typeof value !== 'boolean')
      throw new TypeError('Global shortcut modifier ' + name + ' must be a boolean')
    return value
  }
  const modifiers = {
    control: flag('control'),
    alt: flag('alt'),
    shift: flag('shift'),
    platform: flag('platform'),
  }
  if (!modifiers.control && !modifiers.alt && !modifiers.platform)
    throw new TypeError('A global shortcut requires control, alt or platform')
  return { key, modifiers }
}

/** Internal registry entry. Consumers only receive its frozen handle. */
export class ShortcutRegistration extends Registration<GlobalShortcutEvent> {
  readonly handle: NativeGlobalShortcut

  constructor(
    id: number,
    windowId: number,
    key: GlobalShortcutKey,
    modifiers: ShortcutModifiers,
    listener: Listener<GlobalShortcutEvent>,
    release: (registration: ShortcutRegistration) => Promise<void>
  ) {
    super(id, windowId, listener)
    this.handle = publicHandle(this, key, modifiers, release)
  }
}

function publicHandle(
  registration: ShortcutRegistration,
  key: GlobalShortcutKey,
  modifiers: ShortcutModifiers,
  release: (registration: ShortcutRegistration) => Promise<void>
): NativeGlobalShortcut {
  return Object.freeze({
    key,
    modifiers: Object.freeze({ ...modifiers }),
    get active() {
      return registration.live
    },
    unregister: () => registration.release(release),
  })
}

import { GLOBAL_SHORTCUT_KEYS, type ShortcutModifiers } from '@bun-native/protocol'
import type { Listener } from './types.ts'

type Letter =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type FunctionKey = `f${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`

/** Layout-level key names; the native backend grabs the unshifted key that produces them. */
export type GlobalShortcutKey = Letter | Digit | FunctionKey

export interface GlobalShortcutOptions {
  readonly key: GlobalShortcutKey
  readonly control?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  /** Super on Linux. At least one of control, alt or platform is required. */
  readonly platform?: boolean
}

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
export class ShortcutRegistration {
  readonly handle: NativeGlobalShortcut
  readonly controller = new AbortController()
  listener: Listener<GlobalShortcutEvent> | undefined
  private released = false
  private releasing: Promise<void> | undefined

  constructor(
    readonly id: number,
    readonly windowId: number,
    key: GlobalShortcutKey,
    modifiers: ShortcutModifiers,
    listener: Listener<GlobalShortcutEvent>,
    release: (registration: ShortcutRegistration) => Promise<void>
  ) {
    this.listener = listener
    this.handle = publicHandle(this, key, modifiers, release)
  }

  /** Shared by the public handle; one release per registration. */
  release(release: (registration: ShortcutRegistration) => Promise<void>): Promise<void> {
    this.releasing ??= this.released ? Promise.resolve() : release(this)
    return this.releasing
  }

  get live(): boolean {
    return !this.released
  }

  /** Synchronous local revocation; the native grab is released separately. */
  revoke(): void {
    if (this.released) return
    this.released = true
    this.listener = undefined
    this.controller.abort()
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

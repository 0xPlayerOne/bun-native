import {
  APP_MENU_KEYS,
  MAX_APP_MENU_DEPTH,
  MAX_APP_MENU_ENTRIES,
  parseAppMenus,
  ProtocolError,
  type AppMenu,
  type AppMenuEntry,
} from '@bun-native/protocol'
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
type Punctuation = ',' | '.' | '/' | ';' | "'" | '[' | ']' | '-' | '=' | '`' | '\\'
type NamedKey =
  | 'enter'
  | 'escape'
  | 'tab'
  | 'space'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'

/** The closed key set of a menu shortcut. */
export type MenuShortcutKey = Letter | Digit | FunctionKey | Punctuation | NamedKey

export interface MenuShortcutOptions {
  readonly key: MenuShortcutKey
  readonly control?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  /** Command on macOS. Every key except f1-f12 needs control, alt or platform. */
  readonly platform?: boolean
}

export type MenuEntryOptions =
  | Readonly<{
      kind: 'item'
      /** Reported back on selection: 1-64 of `A-Z a-z 0-9 . _ : -`, unique in the bar. */
      id: string
      label: string
      /** Shown beside the item and bound while the bar is installed; unique in the bar. */
      shortcut?: MenuShortcutOptions
      /** Default true. */
      enabled?: boolean
      /** Default false. */
      checked?: boolean
    }>
  | Readonly<{ kind: 'separator' }>
  | Readonly<{
      kind: 'submenu'
      label: string
      /** Default true. */
      enabled?: boolean
      items: readonly MenuEntryOptions[]
    }>

export interface MenuOptions {
  /** On macOS the first menu is the application menu, shown under the process name. */
  readonly title: string
  readonly items: readonly MenuEntryOptions[]
}

export interface AppMenuItemEvent {
  readonly type: 'app_menu_item'
  readonly sequence: number
  /** The application's `id` of the selected item. */
  readonly itemId: string
  readonly menuBar: NativeMenuBar
  /** Aborted when the bar is replaced, cleared, or the app stops. */
  readonly signal: AbortSignal
}

export interface NativeMenuBar {
  /** False once replaced, cleared or revoked; no later selection is delivered. */
  readonly active: boolean
  /** Removes this bar if it is still installed. Idempotent; a replaced bar is left alone. */
  clear(): Promise<void>
}

function options(value: unknown, field: string, allowed: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(field + ' must be an object')
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError('Unknown ' + field + ' option')
  return value as Record<string, unknown>
}

function flag(data: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = Object.hasOwn(data, key) ? data[key] : fallback
  if (typeof value !== 'boolean') throw new TypeError('Menu ' + key + ' must be a boolean')
  return value
}

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(field + ' must be an array')
  return value
}

interface Budget {
  entries: number
}

function shortcut(
  value: unknown
): NonNullable<Extract<AppMenuEntry, { kind: 'item' }>['shortcut']> {
  const data = options(value, 'Menu shortcut', ['key', 'control', 'alt', 'shift', 'platform'])
  const key = data['key']
  if (typeof key !== 'string' || !APP_MENU_KEYS.includes(key))
    throw new TypeError('Menu shortcut key is not in the closed key set')
  return {
    key,
    modifiers: {
      control: flag(data, 'control', false),
      alt: flag(data, 'alt', false),
      shift: flag(data, 'shift', false),
      platform: flag(data, 'platform', false),
    },
  }
}

function entries(value: unknown, depth: number, budget: Budget): AppMenuEntry[] {
  // Bounded before recursion, so a cyclic or huge consumer object is rejected.
  return list(value, 'Menu items').map((raw): AppMenuEntry => {
    if (++budget.entries > MAX_APP_MENU_ENTRIES)
      throw new TypeError('A menu bar holds at most 128 entries')
    const kind =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['kind'] : undefined
    switch (kind) {
      case 'item': {
        const data = options(raw, 'Menu item', [
          'kind',
          'id',
          'label',
          'shortcut',
          'enabled',
          'checked',
        ])
        return {
          kind: 'item',
          id: data['id'] as string,
          label: data['label'] as string,
          ...(Object.hasOwn(data, 'shortcut') ? { shortcut: shortcut(data['shortcut']) } : {}),
          enabled: flag(data, 'enabled', true),
          checked: flag(data, 'checked', false),
        }
      }
      case 'separator':
        options(raw, 'Menu separator', ['kind'])
        return { kind: 'separator' }
      case 'submenu': {
        const data = options(raw, 'Submenu', ['kind', 'label', 'enabled', 'items'])
        if (depth >= MAX_APP_MENU_DEPTH)
          throw new TypeError('Submenus nest at most two levels below a top-level menu')
        return {
          kind: 'submenu',
          label: data['label'] as string,
          enabled: flag(data, 'enabled', true),
          items: entries(data['items'], depth + 1, budget),
        }
      }
      default:
        throw new TypeError("Menu entry kind must be 'item', 'separator' or 'submenu'")
    }
  })
}

/** The entries of one menu in wire shape, not yet validated as a whole. */
export function menuEntriesRequest(items: readonly MenuEntryOptions[]): AppMenuEntry[] {
  return entries(items, 1, { entries: 0 })
}

/** Copies consumer options into the closed wire shape and validates it with the shared parser. */
export function menuBarRequest(menus: readonly MenuOptions[]): AppMenu[] {
  const budget: Budget = { entries: 0 }
  const wire = list(menus, 'Menu bar').map((raw) => {
    const data = options(raw, 'Menu', ['title', 'items'])
    return {
      title: data['title'] as string,
      items: entries(data['items'], 1, budget),
    }
  })
  try {
    return parseAppMenus(wire)
  } catch (error) {
    if (error instanceof ProtocolError) throw new TypeError(error.message)
    throw error
  }
}

/** Internal registry entry. Consumers only receive its frozen handle. */
export class MenuBarRegistration {
  readonly handle: NativeMenuBar
  readonly controller = new AbortController()
  listener: Listener<AppMenuItemEvent> | undefined
  private revoked = false
  private clearing: Promise<void> | undefined

  constructor(
    readonly id: number,
    listener: Listener<AppMenuItemEvent>,
    clear: (registration: MenuBarRegistration) => Promise<void>
  ) {
    this.listener = listener
    this.handle = publicHandle(this, clear)
  }

  /** Shared by the public handle; one clear per registration. */
  clear(clear: (registration: MenuBarRegistration) => Promise<void>): Promise<void> {
    this.clearing ??= this.revoked ? Promise.resolve() : clear(this)
    return this.clearing
  }

  get live(): boolean {
    return !this.revoked
  }

  /** Synchronous local revocation; the native bar is replaced separately. */
  revoke(): void {
    if (this.revoked) return
    this.revoked = true
    this.listener = undefined
    this.controller.abort()
  }
}

function publicHandle(
  registration: MenuBarRegistration,
  clear: (registration: MenuBarRegistration) => Promise<void>
): NativeMenuBar {
  return Object.freeze({
    get active() {
      return registration.live
    },
    clear: () => registration.clear(clear),
  })
}

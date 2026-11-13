import { ProtocolError } from './framing.ts'
import { fields, keys, object, string } from './values.ts'
import {
  MAX_APP_MENUS,
  MAX_APP_MENU_DEPTH,
  MAX_APP_MENU_ENTRIES,
  MAX_APP_MENU_LABEL_BYTES,
} from './wire-schema.ts'

const APP_MENU_NAMED_KEYS = Object.freeze([
  'enter',
  'escape',
  'tab',
  'space',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
] as const)
const APP_MENU_PUNCTUATION_KEYS = Object.freeze([
  ',',
  '.',
  '/',
  ';',
  "'",
  '[',
  ']',
  '-',
  '=',
  '`',
  '\\',
] as const)

/** The closed key set of a menu shortcut. */
export const APP_MENU_KEYS = Object.freeze([
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  ...APP_MENU_PUNCTUATION_KEYS,
  ...APP_MENU_NAMED_KEYS,
]) as readonly string[]

export interface MenuShortcutModifiers {
  control: boolean
  alt: boolean
  shift: boolean
  /** Command on macOS. */
  platform: boolean
}

export interface MenuShortcut {
  key: string
  modifiers: MenuShortcutModifiers
}

export type AppMenuEntry =
  | {
      kind: 'item'
      id: string
      label: string
      shortcut?: MenuShortcut
      enabled: boolean
      checked: boolean
    }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; enabled: boolean; items: AppMenuEntry[] }

export interface AppMenu {
  title: string
  items: AppMenuEntry[]
}

const ITEM_ID = /^[A-Za-z0-9._:-]{1,64}$/

/** `[A-Za-z0-9._:-]`, 1-64 bytes: an application identifier, never a native name. */
export function parseAppMenuItemId(value: unknown): string {
  if (typeof value !== 'string' || !ITEM_ID.test(value))
    throw new ProtocolError(
      "Menu item id must be 1-64 bytes of letters, digits, '.', '_', ':' or '-'"
    )
  return value
}

function label(value: unknown, field: string): string {
  const text = string(value, field, MAX_APP_MENU_LABEL_BYTES)
  if (!text || /\p{Cc}/u.test(text))
    throw new ProtocolError(field + ' must be nonempty and contain no control characters')
  return text
}

function flag(data: Record<string, unknown>, key: string): boolean {
  const value = data[key]
  if (typeof value !== 'boolean') throw new ProtocolError('Menu ' + key + ' must be a boolean')
  return value
}

const isFunctionKey = (key: string) => /^f([1-9]|1[0-2])$/.test(key)

const MENU_SHORTCUT_KEYS = fields('key', 'modifiers')
const MENU_MODIFIER_KEYS = fields('control', 'alt', 'shift', 'platform')

function parseMenuShortcut(value: unknown): MenuShortcut {
  const data = object(value)
  keys(data, MENU_SHORTCUT_KEYS)
  const key = data['key']
  if (typeof key !== 'string' || !APP_MENU_KEYS.includes(key))
    throw new ProtocolError('Menu shortcut key is not in the closed key set')
  const raw = object(data['modifiers'])
  keys(raw, MENU_MODIFIER_KEYS)
  const modifiers = {
    control: flag(raw, 'control'),
    alt: flag(raw, 'alt'),
    shift: flag(raw, 'shift'),
    platform: flag(raw, 'platform'),
  }
  if (!isFunctionKey(key) && !modifiers.control && !modifiers.alt && !modifiers.platform)
    throw new ProtocolError('Menu shortcut requires control, alt or platform unless it is f1-f12')
  return { key, modifiers }
}

const shortcutKey = ({ key, modifiers: m }: MenuShortcut) =>
  `${+m.control}${+m.alt}${+m.shift}${+m.platform}${key}`

interface Census {
  entries: number
  ids: Set<string>
  shortcuts: Set<string>
}

const ENTRIES_ITEM_KEYS = fields('kind', 'id', 'label', 'shortcut', 'enabled', 'checked')
const ENTRIES_SEPARATOR_KEYS = fields('kind')
const ENTRIES_SUBMENU_KEYS = fields('kind', 'label', 'enabled', 'items')

function entries(value: unknown, depth: number, census: Census): AppMenuEntry[] {
  if (!Array.isArray(value) || !value.length)
    throw new ProtocolError('A menu or submenu needs at least one entry')
  return value.map((raw): AppMenuEntry => {
    if (++census.entries > MAX_APP_MENU_ENTRIES)
      throw new ProtocolError('A menu bar holds at most 128 entries')
    const data = object(raw)
    switch (data['kind']) {
      case 'item': {
        keys(data, ENTRIES_ITEM_KEYS)
        const id = parseAppMenuItemId(data['id'])
        if (census.ids.has(id))
          throw new ProtocolError('Menu item ids must be unique in a menu bar')
        census.ids.add(id)
        const entry: AppMenuEntry = {
          kind: 'item',
          id,
          label: label(data['label'], 'menu label'),
          enabled: flag(data, 'enabled'),
          checked: flag(data, 'checked'),
        }
        if ('shortcut' in data) {
          const shortcut = parseMenuShortcut(data['shortcut'])
          const identity = shortcutKey(shortcut)
          if (census.shortcuts.has(identity))
            throw new ProtocolError('Menu shortcuts must be unique in a menu bar')
          census.shortcuts.add(identity)
          entry.shortcut = shortcut
        }
        return entry
      }
      case 'separator':
        keys(data, ENTRIES_SEPARATOR_KEYS)
        return { kind: 'separator' }
      case 'submenu': {
        keys(data, ENTRIES_SUBMENU_KEYS)
        const text = label(data['label'], 'menu label')
        const enabled = flag(data, 'enabled')
        if (depth >= MAX_APP_MENU_DEPTH)
          throw new ProtocolError('Submenus nest at most two levels below a top-level menu')
        return {
          kind: 'submenu',
          label: text,
          enabled,
          items: entries(data['items'], depth + 1, census),
        }
      }
      default:
        throw new ProtocolError('Unknown menu entry kind')
    }
  })
}

/**
 * A context menu: the entries of one menu-bar menu, with the same bounds,
 * unique ids and shortcuts, and submenus nested at most two levels deep.
 */
export function parseContextMenuItems(value: unknown): AppMenuEntry[] {
  return entries(value, 1, { entries: 0, ids: new Set(), shortcuts: new Set() })
}

const APP_MENUS_KEYS = fields('title', 'items')

/** An empty bar is valid: it removes the application's menus. */
export function parseAppMenus(value: unknown): AppMenu[] {
  if (!Array.isArray(value) || value.length > MAX_APP_MENUS)
    throw new ProtocolError('A menu bar holds at most 16 menus')
  const census: Census = { entries: 0, ids: new Set(), shortcuts: new Set() }
  return value.map((raw) => {
    const data = object(raw)
    keys(data, APP_MENUS_KEYS)
    return {
      title: label(data['title'], 'menu title'),
      items: entries(data['items'], 1, census),
    }
  })
}

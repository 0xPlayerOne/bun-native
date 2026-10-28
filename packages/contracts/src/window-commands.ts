import { BunlyError } from './core.ts'
import type { PolicyScope } from './desktop.ts'
import type { OperationOptions } from './index.ts'

declare const commandsBrand: unique symbol
/** In-process identity; the public ID is diagnostic data, never authority. */
export interface WindowCommandsHandle {
  readonly id: string
  readonly [commandsBrand]: true
}
/** Literal modifiers on every platform. Command/Meta and global shortcuts are unsupported. */
export interface WindowShortcut {
  readonly key: string
  readonly control?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
}
export interface WindowCommand {
  readonly id: string
  readonly label: string
  readonly enabled?: boolean
  readonly shortcut?: WindowShortcut
}
export type WindowMenuItem =
  | { readonly type: 'command'; readonly command: string }
  | { readonly type: 'separator' }
  | { readonly type: 'submenu'; readonly label: string; readonly items: readonly WindowMenuItem[] }
export interface WindowCommandsDefinition {
  readonly commands: readonly WindowCommand[]
  /** Empty is permitted for registrations containing only shortcuts. */
  readonly menu: readonly WindowMenuItem[]
}
export interface WindowMenuPoint {
  /** Integer device-independent coordinates relative to the owning window's client area. */
  readonly x: number
  readonly y: number
}
export type WindowCommandsEvent =
  | {
      readonly type: 'command'
      readonly sequence: number
      readonly command: string
      readonly source: 'menu' | 'shortcut'
    }
  | { readonly type: 'menu-shown' | 'menu-closed' | 'menu-failed'; readonly sequence: number }
  | { readonly type: 'revoked'; readonly sequence: number }

/** Optional native popup-menu and window-local accelerator facet. */
export interface WindowCommandsBackend {
  /** The signal owns the registration until disposal, including after this promise resolves. */
  createWindowCommands(
    scope: PolicyScope,
    definition: WindowCommandsDefinition,
    options?: OperationOptions
  ): Promise<WindowCommandsHandle>
  /** Acknowledges admission. Native opening/closure/failure is reported separately by events. */
  showWindowMenu(
    commands: WindowCommandsHandle,
    point: WindowMenuPoint,
    options?: OperationOptions
  ): Promise<void>
  /** Requests cancellation. A live popup remains owned until the native closed event. */
  cancelWindowMenu(commands: WindowCommandsHandle): Promise<void>
  onWindowCommandsEvent(
    commands: WindowCommandsHandle,
    listener: (event: WindowCommandsEvent) => void,
    options?: OperationOptions
  ): () => void
  /** Idempotent for an authentic handle; unregisters only this registration's shortcuts. */
  disposeWindowCommands(commands: WindowCommandsHandle): Promise<void>
}

export const WINDOW_COMMAND_LIMITS = Object.freeze({
  registrations: 64,
  registrationsPerWindow: 8,
  commands: 32,
  menuItems: 64,
  menuDepth: 3,
  labelBytes: 128,
  listeners: 16,
})
function invalid(message: string): never {
  throw new BunlyError('INVALID_ARGUMENT', `Invalid window commands: ${message}`)
}
function record(value: unknown, allowed: readonly string[], required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected object')
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(object, key))
  )
    invalid('unexpected or missing field')
  return object
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > WINDOW_COMMAND_LIMITS.labelBytes)
    invalid('label')
  // CEF uses ampersands for mnemonic markup. This first facet accepts plain labels.
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x20 || unit === 0x7f || unit === 0x26)
      invalid('label contains controls or mnemonic markup')
    if (unit >= 0xdc00 && unit <= 0xdfff) invalid('unpaired Unicode surrogate')
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('unpaired Unicode surrogate')
    }
  }
  if (new TextEncoder().encode(value).length > WINDOW_COMMAND_LIMITS.labelBytes)
    invalid('label exceeds UTF-8 limit')
  return value
}
/** A canonical chord used only for duplicate detection, never interpreted as an OS command. */
export function windowShortcutKey(shortcut: WindowShortcut): string {
  return `${shortcut.control ? 1 : 0}${shortcut.alt ? 1 : 0}${shortcut.shift ? 1 : 0}:${shortcut.key}`
}
function shortcut(value: unknown): WindowShortcut {
  const input = record(value, ['key', 'control', 'alt', 'shift'], ['key'])
  const key = input['key']
  if (typeof key !== 'string' || !/^(?:[A-Z0-9]|F[1-9]|F1[0-2])$/.test(key))
    invalid('shortcut key must be A–Z, 0–9 or F1–F12')
  for (const modifier of ['control', 'alt', 'shift'])
    if (input[modifier] !== undefined && typeof input[modifier] !== 'boolean')
      invalid('shortcut modifier')
  if (key.length === 1 && input['control'] !== true && input['alt'] !== true)
    invalid('character shortcut requires Control or Alt')
  return Object.freeze({
    key,
    control: input['control'] === true,
    alt: input['alt'] === true,
    shift: input['shift'] === true,
  })
}

/** Validate and snapshot before any asynchronous boundary or native side effect. */
export function normalizeWindowCommands(value: unknown): WindowCommandsDefinition {
  const input = record(value, ['commands', 'menu'])
  const rawCommands = input['commands']
  const rawMenu = input['menu']
  if (
    !Array.isArray(rawCommands) ||
    rawCommands.length < 1 ||
    rawCommands.length > WINDOW_COMMAND_LIMITS.commands
  )
    invalid('command count')
  const ids = new Set<string>()
  const chords = new Set<string>()
  const normalizeCommand = (value: unknown): WindowCommand => {
    const command = record(value, ['id', 'label', 'enabled', 'shortcut'], ['id', 'label'])
    const id = command['id']
    if (typeof id !== 'string' || !/^[a-z][a-z0-9.-]{0,31}$/.test(id) || ids.has(id))
      invalid('duplicate or invalid command ID')
    ids.add(id)
    if (command['enabled'] !== undefined && typeof command['enabled'] !== 'boolean')
      invalid('enabled must be boolean')
    const key = command['shortcut'] === undefined ? undefined : shortcut(command['shortcut'])
    if (key) {
      const chord = windowShortcutKey(key)
      if (chords.has(chord)) invalid('duplicate shortcut')
      chords.add(chord)
    }
    return Object.freeze({
      id,
      label: label(command['label']),
      enabled: command['enabled'] !== false,
      ...(key ? { shortcut: key } : {}),
    })
  }
  const commands: WindowCommand[] = []
  const commandCount = rawCommands.length
  for (let index = 0; index < commandCount; index++)
    commands.push(normalizeCommand(rawCommands[index]))
  let count = 0
  const used = new Set<string>()
  const menu = (value: unknown, depth: number): readonly WindowMenuItem[] => {
    if (!Array.isArray(value) || depth > WINDOW_COMMAND_LIMITS.menuDepth) invalid('menu depth')
    if (value.length > WINDOW_COMMAND_LIMITS.menuItems) invalid('menu item count')
    let previousSeparator = true
    const normalizeItem = (value: unknown): WindowMenuItem => {
      if (++count > WINDOW_COMMAND_LIMITS.menuItems) invalid('menu item count')
      if (!value || typeof value !== 'object') invalid('menu item')
      const type = (value as Record<string, unknown>)['type']
      if (type === 'separator') {
        record(value, ['type'])
        if (previousSeparator) invalid('leading or repeated separator')
        previousSeparator = true
        return Object.freeze({ type })
      }
      previousSeparator = false
      if (type === 'command') {
        const command = record(value, ['type', 'command'])['command']
        if (typeof command !== 'string' || !ids.has(command) || used.has(command))
          invalid('unknown or repeated menu command')
        used.add(command)
        return Object.freeze({ type, command })
      }
      if (type === 'submenu') {
        const item = record(value, ['type', 'label', 'items'])
        const children = menu(item['items'], depth + 1)
        if (!children.length) invalid('empty submenu')
        return Object.freeze({ type, label: label(item['label']), items: children })
      }
      return invalid('unknown menu item type')
    }
    const items: WindowMenuItem[] = []
    const itemCount = value.length
    for (let index = 0; index < itemCount; index++) items.push(normalizeItem(value[index]))
    if (items.length && previousSeparator) invalid('trailing separator')
    return Object.freeze(items)
  }
  const items = menu(rawMenu, 1)
  if (!items.length && commands.every((command) => !command.shortcut))
    invalid('registration requires a menu or shortcut')
  return Object.freeze({ commands: Object.freeze(commands), menu: items })
}

export function validateWindowMenuPoint(value: unknown): asserts value is WindowMenuPoint {
  const point = record(value, ['x', 'y'])
  for (const axis of ['x', 'y'])
    if (
      !Number.isSafeInteger(point[axis]) ||
      Number(point[axis]) < 0 ||
      Number(point[axis]) > 16383
    )
      invalid('menu point must be within the bounded client area')
}

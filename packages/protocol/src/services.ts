import { ProtocolError } from './framing.ts'
import { keys, number, object, string } from './values.ts'

// Worst-case JSON escaping still leaves room within the 64KiB frame.
export const MAX_CLIPBOARD_BYTES = 8_192
export const MAX_SERVICE_REQUESTS = 8
export const MAX_GLOBAL_SHORTCUTS = 16
export const MAX_NOTIFICATIONS = 32
export const MAX_NOTIFICATION_TITLE_BYTES = 256
export const MAX_NOTIFICATION_BODY_BYTES = 2_048

export interface ServicePolicy {
  window_display: boolean
  clipboard_read: boolean
  clipboard_write: boolean
  global_shortcuts: boolean
  notifications: boolean
}

/** The closed set of layout-level keys a global shortcut may name. */
export const GLOBAL_SHORTCUT_KEYS = Object.freeze([
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
] as const) as readonly string[]

export interface ShortcutModifiers {
  control: boolean
  alt: boolean
  shift: boolean
  platform: boolean
}

export function parseShortcutModifiers(value: unknown): ShortcutModifiers {
  const data = object(value)
  keys(data, ['control', 'alt', 'shift', 'platform'])
  const flag = (key: keyof ShortcutModifiers) => {
    if (typeof data[key] !== 'boolean')
      throw new ProtocolError('Global shortcut modifiers must state each modifier explicitly')
    return data[key]
  }
  const modifiers = {
    control: flag('control'),
    alt: flag('alt'),
    shift: flag('shift'),
    platform: flag('platform'),
  }
  if (!modifiers.control && !modifiers.alt && !modifiers.platform)
    throw new ProtocolError('Global shortcut requires control, alt or platform')
  return modifiers
}

export function parseShortcutKey(value: unknown): string {
  if (typeof value !== 'string' || !GLOBAL_SHORTCUT_KEYS.includes(value))
    throw new ProtocolError('Global shortcut key must be one of a-z, 0-9 or f1-f12')
  return value
}

/** Plain-text notification content: one nonempty title line and a body that
 * may hold line feeds but no other control characters. Neither is markup. */
export function parseNotificationContent(title: unknown, body: unknown) {
  const parsedTitle = string(title, 'notification title', MAX_NOTIFICATION_TITLE_BYTES)
  if (!parsedTitle || /\p{Cc}/u.test(parsedTitle))
    throw new ProtocolError('Notification title must be nonempty and contain no control characters')
  const parsedBody = string(body, 'notification body', MAX_NOTIFICATION_BODY_BYTES)
  if (/[^\P{Cc}\n]/u.test(parsedBody))
    throw new ProtocolError(
      'Notification body may contain no control characters other than line feeds'
    )
  return { title: parsedTitle, body: parsedBody }
}

export const NOTIFICATION_DISMISSALS = Object.freeze(['expired', 'dismissed', 'closed'] as const)
export type NotificationDismissal = (typeof NOTIFICATION_DISMISSALS)[number]

export function parseNotificationDismissal(value: unknown): NotificationDismissal {
  if (!NOTIFICATION_DISMISSALS.includes(value as NotificationDismissal))
    throw new ProtocolError('Unknown notification dismissal reason')
  return value as NotificationDismissal
}

export type ClipboardText = { kind: 'empty' } | { kind: 'text'; text: string }

export function parseClipboardText(value: unknown): ClipboardText {
  const data = object(value)
  if (data['kind'] === 'empty') {
    keys(data, ['kind'])
    return { kind: 'empty' }
  }
  keys(data, ['kind', 'text'])
  if (data['kind'] !== 'text') throw new ProtocolError('Unknown clipboard text result')
  return { kind: 'text', text: string(data['text'], 'clipboard text', MAX_CLIPBOARD_BYTES) }
}

interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplaySnapshot {
  bounds: DisplayBounds
  scale_factor: number
}

export function parseServicePolicy(value: unknown): ServicePolicy {
  const data = object(value)
  keys(data, [
    'window_display',
    'clipboard_read',
    'clipboard_write',
    'global_shortcuts',
    'notifications',
  ])
  const grant = (key: keyof ServicePolicy) => {
    if (typeof data[key] !== 'boolean')
      throw new ProtocolError('Native service policy must explicitly grant or deny each operation')
    return data[key]
  }
  return {
    window_display: grant('window_display'),
    clipboard_read: grant('clipboard_read'),
    clipboard_write: grant('clipboard_write'),
    global_shortcuts: grant('global_shortcuts'),
    notifications: grant('notifications'),
  }
}

export function parseDisplaySnapshot(value: unknown): DisplaySnapshot {
  const data = object(value)
  keys(data, ['bounds', 'scale_factor'])
  const bounds = object(data['bounds'])
  keys(bounds, ['x', 'y', 'width', 'height'])
  return {
    bounds: {
      x: number(bounds['x'], 'display x', -1_048_576, 1_048_576),
      y: number(bounds['y'], 'display y', -1_048_576, 1_048_576),
      width: number(bounds['width'], 'display width', Number.MIN_VALUE, 1_048_576),
      height: number(bounds['height'], 'display height', Number.MIN_VALUE, 1_048_576),
    },
    scale_factor: number(data['scale_factor'], 'display scale factor', 0.125, 16),
  }
}

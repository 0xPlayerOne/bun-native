import { ProtocolError } from './framing.ts'
import { keys, number, object, string } from './values.ts'

// Worst-case JSON escaping still leaves room within the 64KiB frame.
export const MAX_CLIPBOARD_BYTES = 8_192
export const MAX_SERVICE_REQUESTS = 8

export interface ServicePolicy {
  window_display: boolean
  clipboard_read: boolean
  clipboard_write: boolean
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
  keys(data, ['window_display', 'clipboard_read', 'clipboard_write'])
  const grant = (key: keyof ServicePolicy) => {
    if (typeof data[key] !== 'boolean')
      throw new ProtocolError('Native service policy must explicitly grant or deny each operation')
    return data[key]
  }
  return {
    window_display: grant('window_display'),
    clipboard_read: grant('clipboard_read'),
    clipboard_write: grant('clipboard_write'),
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

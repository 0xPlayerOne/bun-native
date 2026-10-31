import { ProtocolError } from './framing.ts'

export const PROTOCOL_VERSION = 1
export const MAX_TEXT_BYTES = 16_384
export const MAX_TITLE_BYTES = 256

export type Command =
  | { id: number; type: 'hello'; protocol: typeof PROTOCOL_VERSION }
  | { id: number; type: 'open'; title: string; text: string; input: string }
  | { id: number; type: 'update'; text?: string; input?: string }
  | { id: number; type: 'close' }
  | { id: number; type: 'shutdown' }

export type NativeEvent =
  | { type: 'ready'; protocol: typeof PROTOCOL_VERSION }
  | { type: 'ack'; id: number }
  | { type: 'opened'; id: number }
  | { type: 'click' }
  | { type: 'input'; value: string }
  | { type: 'closed' }
  | { type: 'error'; id?: number; code: string; message: string }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError('Message must be an object')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new ProtocolError(`Unknown message property: ${key}`)
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new ProtocolError('Message id must be a positive safe integer')
  return value
}

function string(value: unknown, field: string, limit = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > limit)
    throw new ProtocolError(`${field} must be a string within ${limit} UTF-8 bytes`)
  // JSON escapes can represent invalid Unicode; Rust strings cannot.
  if (!value.isWellFormed()) throw new ProtocolError(`${field} contains an unpaired surrogate`)
  if (value.includes('\0')) throw new ProtocolError(`${field} contains a NUL character`)
  return value
}

function version(value: unknown): typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) throw new ProtocolError('Native protocol version mismatch')
  return PROTOCOL_VERSION
}

/** Validate before crossing the native boundary, including JavaScript callers. */
export function parseCommand(value: unknown): Command {
  const message = object(value)
  const request = id(message['id'])
  switch (message['type']) {
    case 'hello':
      keys(message, ['id', 'type', 'protocol'])
      return { id: request, type: 'hello', protocol: version(message['protocol']) }
    case 'open': {
      keys(message, ['id', 'type', 'title', 'text', 'input'])
      const title = string(message['title'], 'title', MAX_TITLE_BYTES)
      if (!title || /\p{Cc}/u.test(title))
        throw new ProtocolError('Window title must be nonempty and contain no control characters')
      return {
        id: request,
        type: 'open',
        title,
        text: string(message['text'], 'text'),
        input: string(message['input'], 'input'),
      }
    }
    case 'update': {
      keys(message, ['id', 'type', 'text', 'input'])
      if (!('text' in message) && !('input' in message))
        throw new ProtocolError('Update must change text or input')
      return {
        id: request,
        type: 'update',
        ...('text' in message ? { text: string(message['text'], 'text') } : {}),
        ...('input' in message ? { input: string(message['input'], 'input') } : {}),
      }
    }
    case 'close':
    case 'shutdown':
      keys(message, ['id', 'type'])
      return { id: request, type: message['type'] }
    default:
      throw new ProtocolError('Unknown native command')
  }
}

/** Native stdout is untrusted until its message shape and limits are checked. */
export function parseEvent(value: unknown): NativeEvent {
  const message = object(value)
  switch (message['type']) {
    case 'ready':
      keys(message, ['type', 'protocol'])
      return { type: 'ready', protocol: version(message['protocol']) }
    case 'ack':
    case 'opened':
      keys(message, ['type', 'id'])
      return { type: message['type'], id: id(message['id']) }
    case 'click':
    case 'closed':
      keys(message, ['type'])
      return { type: message['type'] }
    case 'input':
      keys(message, ['type', 'value'])
      return { type: 'input', value: string(message['value'], 'value') }
    case 'error': {
      keys(message, ['type', 'id', 'code', 'message'])
      const code = string(message['code'], 'code', 64)
      if (!/^[a-z][a-z_]*$/.test(code)) throw new ProtocolError('Invalid native error code')
      return {
        type: 'error',
        code,
        message: string(message['message'], 'message'),
        ...('id' in message ? { id: id(message['id']) } : {}),
      }
    }
    default:
      throw new ProtocolError('Unknown native event')
  }
}

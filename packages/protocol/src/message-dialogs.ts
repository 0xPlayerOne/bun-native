import { ProtocolError } from './framing.ts'
import { keys, object, string } from './values.ts'
import {
  MAX_MESSAGE_DIALOG_BUTTONS,
  MAX_MESSAGE_DIALOG_DETAIL_BYTES,
  MAX_MESSAGE_DIALOG_ID_BYTES,
  MAX_MESSAGE_DIALOG_LABEL_BYTES,
  MAX_MESSAGE_DIALOG_MESSAGE_BYTES,
  MAX_MESSAGE_DIALOG_TITLE_BYTES,
  PAYLOAD_KEYS,
} from './wire-schema.ts'

export interface MessageDialogButton {
  id: string
  label: string
}

export interface MessageDialogOptions {
  title: string
  message: string
  detail?: string
  buttons: readonly MessageDialogButton[]
  default_button: string
  cancel_button?: string
  dismissible?: boolean
}

export type MessageDialogResult =
  | { kind: 'button'; id: string }
  | { kind: 'dismissed' }
  | { kind: 'failed' }

/** Nonblank text; a block may contain line feeds, a line may not. */
function text(value: unknown, field: string, limit: number, block: boolean): string {
  const result = string(value, field, limit)
  if (!result.trim()) throw new ProtocolError(field + ' must be nonblank')
  if ((block ? /[^\P{Cc}\n]/u : /\p{Cc}/u).test(result))
    throw new ProtocolError(field + ' contains a control character')
  return result
}

function button(value: unknown): MessageDialogButton {
  const data = object(value)
  keys(data, PAYLOAD_KEYS.message_dialog_button)
  return {
    id: text(data['id'], 'message dialog button id', MAX_MESSAGE_DIALOG_ID_BYTES, false),
    label: text(
      data['label'],
      'message dialog button label',
      MAX_MESSAGE_DIALOG_LABEL_BYTES,
      false
    ),
  }
}

export function parseMessageDialogOptions(value: unknown): MessageDialogOptions {
  const data = object(value)
  keys(data, PAYLOAD_KEYS.message_dialog_options)
  const list = data['buttons']
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_MESSAGE_DIALOG_BUTTONS)
    throw new ProtocolError('A message dialog needs between 1 and 4 buttons')
  const buttons = list.map(button)
  const ids = new Set(buttons.map((entry) => entry.id))
  if (ids.size !== buttons.length)
    throw new ProtocolError('Message dialog button ids must be unique')
  const reference = (field: string) => {
    const name = string(data[field], 'message dialog ' + field, MAX_MESSAGE_DIALOG_ID_BYTES)
    if (!ids.has(name))
      throw new ProtocolError('Message dialog ' + field + ' must name one of its buttons')
    return name
  }
  const options: MessageDialogOptions = {
    title: text(data['title'], 'message dialog title', MAX_MESSAGE_DIALOG_TITLE_BYTES, false),
    message: text(
      data['message'],
      'message dialog message',
      MAX_MESSAGE_DIALOG_MESSAGE_BYTES,
      true
    ),
    buttons,
    default_button: reference('default_button'),
  }
  if ('detail' in data)
    options.detail = text(
      data['detail'],
      'message dialog detail',
      MAX_MESSAGE_DIALOG_DETAIL_BYTES,
      true
    )
  if ('cancel_button' in data) options.cancel_button = reference('cancel_button')
  if ('dismissible' in data) {
    if (typeof data['dismissible'] !== 'boolean')
      throw new ProtocolError('Message dialog dismissible must be a boolean')
    if (data['dismissible']) options.dismissible = true
  }
  return options
}

export function parseMessageDialogResult(value: unknown): MessageDialogResult {
  const data = object(value)
  switch (data['kind']) {
    case 'button':
      keys(data, PAYLOAD_KEYS.message_dialog_result.button)
      return {
        kind: 'button',
        id: text(data['id'], 'message dialog result id', MAX_MESSAGE_DIALOG_ID_BYTES, false),
      }
    case 'dismissed':
      keys(data, PAYLOAD_KEYS.message_dialog_result.dismissed)
      return { kind: 'dismissed' }
    case 'failed':
      keys(data, PAYLOAD_KEYS.message_dialog_result.failed)
      return { kind: 'failed' }
    default:
      throw new ProtocolError('Unknown message dialog result')
  }
}

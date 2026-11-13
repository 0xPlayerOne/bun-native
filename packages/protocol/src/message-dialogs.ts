import { ProtocolError } from './framing.ts'
import { fields, keys, object, string } from './values.ts'

export const MAX_MESSAGE_DIALOG_BUTTONS = 4
export const MAX_MESSAGE_DIALOG_TITLE_BYTES = 256
export const MAX_MESSAGE_DIALOG_MESSAGE_BYTES = 2_048
export const MAX_MESSAGE_DIALOG_DETAIL_BYTES = 4_096
export const MAX_MESSAGE_DIALOG_LABEL_BYTES = 64
export const MAX_MESSAGE_DIALOG_ID_BYTES = 64

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

const BUTTON_KEYS = fields('id', 'label')

function button(value: unknown): MessageDialogButton {
  const data = object(value)
  keys(data, BUTTON_KEYS)
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

const MESSAGE_DIALOG_OPTIONS_KEYS = fields(
  'title',
  'message',
  'detail',
  'buttons',
  'default_button',
  'cancel_button',
  'dismissible'
)

export function parseMessageDialogOptions(value: unknown): MessageDialogOptions {
  const data = object(value)
  keys(data, MESSAGE_DIALOG_OPTIONS_KEYS)
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

const MESSAGE_DIALOG_RESULT_BUTTON_KEYS = fields('kind', 'id')
const MESSAGE_DIALOG_RESULT_DISMISSED_KEYS = fields('kind')
const MESSAGE_DIALOG_RESULT_FAILED_KEYS = fields('kind')

export function parseMessageDialogResult(value: unknown): MessageDialogResult {
  const data = object(value)
  switch (data['kind']) {
    case 'button':
      keys(data, MESSAGE_DIALOG_RESULT_BUTTON_KEYS)
      return {
        kind: 'button',
        id: text(data['id'], 'message dialog result id', MAX_MESSAGE_DIALOG_ID_BYTES, false),
      }
    case 'dismissed':
      keys(data, MESSAGE_DIALOG_RESULT_DISMISSED_KEYS)
      return { kind: 'dismissed' }
    case 'failed':
      keys(data, MESSAGE_DIALOG_RESULT_FAILED_KEYS)
      return { kind: 'failed' }
    default:
      throw new ProtocolError('Unknown message dialog result')
  }
}

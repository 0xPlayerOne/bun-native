import type {
  KeyModifiers,
  MessageDialogOptions as WireMessageDialogOptions,
} from '@bun-native/protocol'
import { NativeServiceError } from './services.ts'
import { defaultTheme } from './theme.ts'
import { NativeStateError, type NativeBatch, type NativeNode, type NativeWindow } from './types.ts'

/** Buttons in one message dialog. */
const MAX_MESSAGE_DIALOG_BUTTONS = 4
/** Dialogs one window holds at a time: the shown one plus those queued behind it. */
const MAX_MESSAGE_DIALOGS_PER_WINDOW = 8
const MAX_TITLE_BYTES = 256
const MAX_MESSAGE_BYTES = 2_048
const MAX_DETAIL_BYTES = 4_096
const MAX_LABEL_BYTES = 64
const MAX_ID_BYTES = 64

export interface MessageDialogButton {
  /** Returned in the result. 1-64 UTF-8 bytes without control characters, unique per dialog. */
  readonly id: string
  /** One nonblank line of at most 64 UTF-8 bytes. */
  readonly label: string
  /** Visual emphasis only; `normal` when absent. */
  readonly kind?: 'normal' | 'primary' | 'destructive'
}

export interface MessageDialogOptions {
  /** One nonblank line of at most 256 UTF-8 bytes. */
  readonly title: string
  /** Nonblank, at most 2,048 UTF-8 bytes; line feeds allowed, other control characters not. */
  readonly message: string
  /** Secondary text, at most 4,096 UTF-8 bytes; line feeds allowed. */
  readonly detail?: string
  /** 1-4 buttons, shown left to right in this order. */
  readonly buttons: readonly MessageDialogButton[]
  /** The button focused when the dialog opens; the first button when absent. */
  readonly defaultButton?: string
  /** The button Escape activates. Without one, Escape only dismisses a `dismissible` dialog. */
  readonly cancelButton?: string
  /** Escape (without a cancel button) and a backdrop press resolve `{ kind: 'dismissed' }`. */
  readonly dismissible?: boolean
}

export type MessageDialogResult =
  | Readonly<{ kind: 'button'; id: string }>
  | Readonly<{ kind: 'dismissed' }>

export interface ConfirmDialogOptions {
  readonly title: string
  readonly message: string
  readonly detail?: string
  /** `OK` when absent. */
  readonly confirmLabel?: string
  /** `Cancel` when absent. */
  readonly cancelLabel?: string
  /** Draws the confirm button as destructive and focuses Cancel by default. */
  readonly destructive?: boolean
}

/** A validated, immutable copy of the caller's options. */
export interface MessageDialogSpec {
  readonly title: string
  readonly message: string
  readonly detail: string | undefined
  readonly buttons: readonly Readonly<Required<MessageDialogButton>>[]
  readonly defaultButton: string
  readonly cancelButton: string | undefined
  readonly dismissible: boolean
}

const MESSAGE_KEYS = [
  'title',
  'message',
  'detail',
  'buttons',
  'defaultButton',
  'cancelButton',
  'dismissible',
]
const CONFIRM_KEYS = ['title', 'message', 'detail', 'confirmLabel', 'cancelLabel', 'destructive']
const BUTTON_KEYS = ['id', 'label', 'kind']
const encoder = new TextEncoder()

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(what + ' must be an object')
  return value as Record<string, unknown>
}

function onlyKeys(data: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const key of Object.keys(data))
    if (!allowed.includes(key)) throw new TypeError('Unknown ' + what + ' option: ' + key)
}

function text(value: unknown, field: string, limit: number, lines: boolean): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError('Message dialog ' + field + ' must be a nonblank string')
  if (value.length > limit || encoder.encode(value).byteLength > limit)
    throw new TypeError('Message dialog ' + field + ' exceeds ' + limit + ' UTF-8 bytes')
  if (!value.isWellFormed())
    throw new TypeError('Message dialog ' + field + ' contains an unpaired surrogate')
  if ((lines ? /[^\P{Cc}\n]/u : /\p{Cc}/u).test(value))
    throw new TypeError('Message dialog ' + field + ' contains a control character')
  return value
}

function optional<T>(data: Record<string, unknown>, key: string, parse: (value: unknown) => T) {
  return data[key] === undefined ? undefined : parse(data[key])
}

function button(value: unknown): Readonly<Required<MessageDialogButton>> {
  const data = record(value, 'A message dialog button')
  onlyKeys(data, BUTTON_KEYS, 'message dialog button')
  const kind = data['kind'] ?? 'normal'
  if (kind !== 'normal' && kind !== 'primary' && kind !== 'destructive')
    throw new TypeError('Message dialog button kind must be normal, primary or destructive')
  return Object.freeze({
    // An id is opaque, so surrounding whitespace is kept but blank ids are not.
    id: text(data['id'], 'button id', MAX_ID_BYTES, false),
    label: text(data['label'], 'button label', MAX_LABEL_BYTES, false),
    kind,
  })
}

/** Validate and copy public options; nothing is staged on failure. */
export function messageDialogSpec(options: MessageDialogOptions): MessageDialogSpec {
  const data = record(options, 'Message dialog options')
  onlyKeys(data, MESSAGE_KEYS, 'message dialog')
  const list = data['buttons']
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_MESSAGE_DIALOG_BUTTONS)
    throw new TypeError(
      'A message dialog needs between 1 and ' + MAX_MESSAGE_DIALOG_BUTTONS + ' buttons'
    )
  const buttons = Object.freeze(list.map(button))
  const ids = new Set(buttons.map((entry) => entry.id))
  if (ids.size !== buttons.length) throw new TypeError('Message dialog button ids must be unique')
  const reference = (field: string) => (value: unknown) => {
    if (typeof value !== 'string' || !ids.has(value))
      throw new TypeError('Message dialog ' + field + ' must name one of its buttons')
    return value
  }
  const dismissible = data['dismissible'] ?? false
  if (typeof dismissible !== 'boolean')
    throw new TypeError('Message dialog dismissible must be a boolean')
  return Object.freeze({
    title: text(data['title'], 'title', MAX_TITLE_BYTES, false),
    message: text(data['message'], 'message', MAX_MESSAGE_BYTES, true),
    detail: optional(data, 'detail', (value) => text(value, 'detail', MAX_DETAIL_BYTES, true)),
    buttons,
    defaultButton: optional(data, 'defaultButton', reference('defaultButton')) ?? buttons[0]!.id,
    cancelButton: optional(data, 'cancelButton', reference('cancelButton')),
    dismissible,
  })
}

/** Cancel then confirm, Escape cancels; a destructive confirmation focuses Cancel. */
export function confirmDialogSpec(options: ConfirmDialogOptions): MessageDialogSpec {
  const data = record(options, 'Confirm dialog options')
  onlyKeys(data, CONFIRM_KEYS, 'confirm dialog')
  const destructive = data['destructive'] ?? false
  if (typeof destructive !== 'boolean')
    throw new TypeError('Confirm dialog destructive must be a boolean')
  return messageDialogSpec({
    title: data['title'] as string,
    message: data['message'] as string,
    ...(data['detail'] === undefined ? {} : { detail: data['detail'] as string }),
    buttons: [
      { id: 'cancel', label: (data['cancelLabel'] ?? 'Cancel') as string },
      {
        id: 'confirm',
        label: (data['confirmLabel'] ?? 'OK') as string,
        kind: destructive ? 'destructive' : 'primary',
      },
    ],
    defaultButton: destructive ? 'cancel' : 'confirm',
    cancelButton: 'cancel',
  })
}

const { colors, space, fontSizes } = defaultTheme.tokens
/** Not a host default: the one color the default theme has no token for. */
const DESTRUCTIVE = 0xb42318
const BUTTON_COLORS = {
  normal: { background: colors['divider']!, color: colors['text']! },
  primary: { background: colors['accent']!, color: colors['on_accent']! },
  destructive: { background: DESTRUCTIVE, color: colors['on_accent']! },
} as const

type Outcome = { result: MessageDialogResult } | { error: Error }

/** The OS backend (Windows task dialogs): the window supplies the host calls. */
export interface NativeMessageDialogBackend {
  allocate(): number
  show(id: number, options: WireMessageDialogOptions): Promise<void>
  /** Resolves once the host no longer owns the dialog (it may already be gone). */
  close(id: number): Promise<void>
}

/** The wire form of a validated spec; button `kind` has no OS equivalent. */
function wireOptions(spec: MessageDialogSpec): WireMessageDialogOptions {
  return {
    title: spec.title,
    message: spec.message,
    ...(spec.detail === undefined ? {} : { detail: spec.detail }),
    buttons: spec.buttons.map(({ id, label }) => ({ id, label })),
    default_button: spec.defaultButton,
    ...(spec.cancelButton === undefined ? {} : { cancel_button: spec.cancelButton }),
    ...(spec.dismissible ? { dismissible: true as const } : {}),
  }
}

class Dialog {
  state: 'queued' | 'opening' | 'open' | 'closing' | 'settled' = 'queued'
  layer: NativeNode<'overlay'> | undefined
  /** The host's identity for an OS dialog the host still owns. */
  nativeId: number | undefined
  readonly buttons = new Map<NativeNode, string>()
  outcome: Outcome | undefined
  detach: () => void = () => {}
  readonly result: Promise<MessageDialogResult>
  resolve!: (result: MessageDialogResult) => void
  reject!: (error: Error) => void

  constructor(readonly spec: MessageDialogSpec) {
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // The caller may not await before revocation rejects it.
    void this.result.catch(() => {})
  }
}

/** The routed native event fields a dialog acts on. */
export type DialogInput =
  | { type: 'click' }
  | { type: 'key_down'; key: string; modifiers: KeyModifiers }
  | { type: string }

/**
 * One window's message dialogs. They are shown one at a time in call order:
 * a later call waits, unseen, until every earlier dialog has settled and its
 * layer has been removed. Input routed through a dialog's layer is handled
 * here during ingestion, never through the callback queue, so a listener may
 * await a dialog without blocking that dialog's own buttons.
 */
export class MessageDialogs {
  private readonly dialogs: Dialog[] = []
  private readonly native = new Map<number, Dialog>()

  /** `backend` is read when a dialog opens: it is the OS backend or the overlay. */
  constructor(
    private readonly window: NativeWindow,
    private readonly backend: () => NativeMessageDialogBackend | undefined = () => undefined
  ) {}

  /** The host finished a dialog it owned. A result for a closed one is dropped. */
  completeNative(
    id: number,
    result: { kind: 'button'; id: string } | { kind: 'dismissed' } | { kind: 'failed' }
  ): void {
    const dialog = this.native.get(id)
    if (!dialog) return
    this.native.delete(id)
    dialog.nativeId = undefined
    if (dialog.state === 'closing' || dialog.state === 'settled') return
    const outcome: Outcome =
      result.kind === 'failed'
        ? {
            error: new NativeServiceError(
              'message_dialogs',
              'native_failure',
              'The native message dialog failed'
            ),
          }
        : { result }
    if (dialog.state === 'opening') {
      // The open call finishes it when the host's reply arrives.
      dialog.outcome = outcome
      dialog.state = 'closing'
    } else this.finish(dialog, outcome)
  }

  show(spec: MessageDialogSpec, signal: AbortSignal | undefined): Promise<MessageDialogResult> {
    if (signal?.aborted)
      return Promise.reject(
        new NativeServiceError('message_dialogs', 'cancelled', 'The message dialog was cancelled')
      )
    if (this.dialogs.length >= MAX_MESSAGE_DIALOGS_PER_WINDOW)
      return Promise.reject(
        new NativeServiceError(
          'message_dialogs',
          'limit_exceeded',
          'This window already holds ' + MAX_MESSAGE_DIALOGS_PER_WINDOW + ' message dialogs'
        )
      )
    const dialog = new Dialog(spec)
    if (signal) {
      const abort = () =>
        this.decide(dialog, {
          error: new NativeServiceError(
            'message_dialogs',
            'cancelled',
            'The message dialog was cancelled'
          ),
        })
      signal.addEventListener('abort', abort, { once: true })
      dialog.detach = () => signal.removeEventListener('abort', abort)
    }
    this.dialogs.push(dialog)
    if (this.dialogs.length === 1) void this.open(dialog)
    return dialog.result
  }

  /**
   * Handle a routed event whose committed path is `path`. Returns true when
   * the event belongs to a dialog layer: it is then not delivered to
   * application listeners.
   */
  receive(event: DialogInput, path: readonly NativeNode[], target: NativeNode): boolean {
    const dialog = this.dialogs[0]
    if (!dialog?.layer || !path.includes(dialog.layer)) return false
    const { spec } = dialog
    if (event.type === 'click') {
      const id = dialog.buttons.get(target)
      if (id !== undefined) this.decide(dialog, { result: { kind: 'button', id } })
    } else if (event.type === 'key_down' && 'key' in event && event.key === 'escape') {
      const { control, alt, shift, platform, function: fn } = event.modifiers
      if (control || alt || shift || platform || fn) return true
      if (spec.cancelButton !== undefined)
        this.decide(dialog, { result: { kind: 'button', id: spec.cancelButton } })
      else if (spec.dismissible) this.decide(dialog, { result: { kind: 'dismissed' } })
    } else if (event.type === 'pointer_down' && target === dialog.layer && spec.dismissible)
      this.decide(dialog, { result: { kind: 'dismissed' } })
    return true
  }

  /** Owner close and shutdown: every dialog rejects at once; nothing is sent. */
  revoke(): void {
    const error = new NativeStateError('invalid_handle', 'Message dialog owner window was closed')
    // The host closes its own dialogs with the owner window or at shutdown.
    this.native.clear()
    for (const dialog of this.dialogs.splice(0)) this.settle(dialog, { error })
  }

  private async openNative(dialog: Dialog, backend: NativeMessageDialogBackend): Promise<void> {
    dialog.state = 'opening'
    let id: number
    try {
      id = backend.allocate()
      dialog.nativeId = id
      this.native.set(id, dialog)
      await backend.show(id, wireOptions(dialog.spec))
    } catch (error) {
      if (dialog.nativeId !== undefined) this.native.delete(dialog.nativeId)
      dialog.nativeId = undefined
      this.finish(dialog, { error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    if (dialog.state === 'opening') dialog.state = 'open'
    else if (dialog.state === 'closing') {
      // Aborted while the host was showing it, or finished before this reply.
      if (dialog.nativeId !== undefined) await this.close(dialog)
      else if (dialog.outcome) this.finish(dialog, dialog.outcome)
    }
  }

  private async open(dialog: Dialog): Promise<void> {
    const backend = this.backend()
    if (backend) return this.openNative(dialog, backend)
    dialog.state = 'opening'
    try {
      await this.window.batch((batch) => build(batch, this.window.root, dialog))
    } catch (error) {
      dialog.layer = undefined
      dialog.buttons.clear()
      this.finish(dialog, { error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    if (dialog.state === 'opening') dialog.state = 'open'
    else if (dialog.state === 'closing') await this.close(dialog)
  }

  /** The first decision wins; the result is delivered after the layer is removed. */
  private decide(dialog: Dialog, outcome: Outcome): void {
    if (dialog.state === 'closing' || dialog.state === 'settled') return
    if (dialog.state === 'queued') {
      this.finish(dialog, outcome)
      return
    }
    dialog.outcome = outcome
    const opened = dialog.state === 'open'
    dialog.state = 'closing'
    if (opened) void this.close(dialog)
  }

  private async close(dialog: Dialog): Promise<void> {
    const id = dialog.nativeId
    if (id !== undefined) {
      // Delivery stops first; a result already queued for it is then dropped.
      this.native.delete(id)
      dialog.nativeId = undefined
      try {
        await this.backend()!.close(id)
      } catch (error) {
        this.finish(dialog, { error: error instanceof Error ? error : new Error(String(error)) })
        return
      }
      this.finish(dialog, dialog.outcome!)
      return
    }
    const layer = dialog.layer!
    try {
      await this.window.batch((batch) => batch.remove(layer))
    } catch (error) {
      // A closed owner has already settled it; any other failure is reported.
      this.finish(dialog, { error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    this.finish(dialog, dialog.outcome!)
  }

  private finish(dialog: Dialog, outcome: Outcome): void {
    if (dialog.state === 'settled') return
    const head = this.dialogs[0] === dialog
    this.dialogs.splice(this.dialogs.indexOf(dialog), 1)
    this.settle(dialog, outcome)
    const next = this.dialogs[0]
    if (head && next) void this.open(next)
  }

  private settle(dialog: Dialog, outcome: Outcome): void {
    dialog.state = 'settled'
    dialog.detach()
    if ('error' in outcome) dialog.reject(outcome.error)
    else dialog.resolve(Object.freeze(outcome.result))
  }
}

/** One window-anchored modal layer with a fixed, theme-default layout. */
function build(batch: NativeBatch, root: NativeNode<'box'>, dialog: Dialog): void {
  const { spec } = dialog
  const layer = batch.create({
    kind: 'overlay',
    modal: true,
    style: { align_items: 'center', justify_content: 'center', padding: space['lg']! },
  })
  // A one-pixel divider frame without the optional decoration capability.
  const frame = batch.create({
    kind: 'box',
    style: { width: 'fill', max_width: 420, padding: 1, background: colors['divider']! },
  })
  const panel = batch.create({
    kind: 'box',
    style: { gap: space['md']!, padding: space['lg']!, background: colors['surface']! },
  })
  batch.append(root, layer)
  batch.append(layer, frame)
  batch.append(frame, panel)
  const line = (value: string, font: number, color: number) =>
    batch.append(
      panel,
      batch.create({ kind: 'text', text: value, style: { font_size: font, color } })
    )
  line(spec.title, fontSizes['body']!, colors['text']!)
  line(spec.message, fontSizes['sm']!, colors['text']!)
  if (spec.detail !== undefined) line(spec.detail, fontSizes['sm']!, colors['disabled']!)
  const row = batch.create({
    kind: 'box',
    style: { direction: 'row', gap: space['sm']!, justify_content: 'end' },
  })
  batch.append(panel, row)
  let focused: NativeNode<'button'> | undefined
  for (const entry of spec.buttons) {
    const node = batch.create({
      kind: 'button',
      text: entry.label,
      style: { padding: space['sm']!, ...BUTTON_COLORS[entry.kind] },
    })
    batch.append(row, node)
    dialog.buttons.set(node, entry.id)
    if (entry.id === spec.defaultButton) focused = node
  }
  batch.focus(focused!)
  dialog.layer = layer
}

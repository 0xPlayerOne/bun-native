import {
  MAX_NOTIFICATION_BODY_BYTES,
  MAX_NOTIFICATION_TITLE_BYTES,
  type NotificationDismissal,
} from '@bun-native/protocol'
import { Registration } from './registration.ts'
import type { Listener } from './types.ts'

export interface NotificationOptions {
  /** One nonempty line of plain text, at most 256 UTF-8 bytes. */
  readonly title: string
  /** Plain text, at most 2048 UTF-8 bytes; line feeds are the only control characters. */
  readonly body?: string
}

export type NotificationEvent =
  | Readonly<{
      type: 'notification_activated'
      sequence: number
      notification: NativeNotification
      /** Aborted when the notification is withdrawn, dismissed, its window closes or the app stops. */
      signal: AbortSignal
    }>
  | Readonly<{
      type: 'notification_dismissed'
      sequence: number
      notification: NativeNotification
      /** `expired` by timeout, `dismissed` by the user, `closed` by the server otherwise. */
      reason: NotificationDismissal
      signal: AbortSignal
    }>

export interface NativeNotification {
  readonly title: string
  readonly body: string
  /** False when the notification server offers no actions: no activation can arrive. */
  readonly activatable: boolean
  /** False once withdrawn, dismissed or revoked; no later activation is delivered. */
  readonly active: boolean
  /** Idempotent. Delivery stops immediately; resolves after the server closes it. */
  withdraw(): Promise<void>
}

const OPTION_KEYS = ['title', 'body']
const encoder = new TextEncoder()

export function notificationRequest(options: NotificationOptions): { title: string; body: string } {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Notification options must be an object')
  if (Object.keys(options).some((key) => !OPTION_KEYS.includes(key)))
    throw new TypeError('Unknown notification option')
  const { title } = options
  const body = Object.hasOwn(options, 'body') ? options.body : ''
  if (
    typeof title !== 'string' ||
    !title ||
    !title.isWellFormed() ||
    encoder.encode(title).byteLength > MAX_NOTIFICATION_TITLE_BYTES ||
    /\p{Cc}/u.test(title)
  )
    throw new TypeError(
      'Notification title must be one nonempty line of at most 256 UTF-8 bytes without control characters'
    )
  if (
    typeof body !== 'string' ||
    !body.isWellFormed() ||
    encoder.encode(body).byteLength > MAX_NOTIFICATION_BODY_BYTES ||
    /[^\P{Cc}\n]/u.test(body)
  )
    throw new TypeError(
      'Notification body must be at most 2048 UTF-8 bytes with no control characters other than line feeds'
    )
  return { title, body }
}

/**
 * Internal registry entry. Consumers only receive its frozen handle. `live`
 * accepts activations; `deliverable` keeps a queued callback, including the
 * final dismissal, runnable.
 */
export class NotificationRegistration extends Registration<NotificationEvent> {
  readonly handle: NativeNotification
  activatable = false

  constructor(
    id: number,
    windowId: number,
    title: string,
    body: string,
    listener: Listener<NotificationEvent>,
    withdraw: (registration: NotificationRegistration) => Promise<void>
  ) {
    super(id, windowId, listener)
    this.handle = publicHandle(this, title, body, withdraw)
  }

  get deliverable(): boolean {
    return this.listener !== undefined
  }

  /** The server removed it: no activation follows, but the dismissal is delivered. */
  end(): void {
    this.released = true
  }
}

function publicHandle(
  registration: NotificationRegistration,
  title: string,
  body: string,
  withdraw: (registration: NotificationRegistration) => Promise<void>
): NativeNotification {
  return Object.freeze({
    title,
    body,
    get activatable() {
      return registration.activatable
    },
    get active() {
      return registration.live
    },
    withdraw: () => registration.release(withdraw),
  })
}

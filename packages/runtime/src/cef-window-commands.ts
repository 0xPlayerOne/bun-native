import {
  BunlyError,
  normalizeWindowCommands,
  validateWindowMenuPoint,
  WINDOW_COMMAND_LIMITS,
  windowShortcutKey,
  type OperationOptions,
  type PolicyScope,
  type ViewHandle,
  type WindowCommandsDefinition,
  type WindowCommandsEvent,
  type WindowCommandsHandle,
  type WindowHandle,
  type WindowMenuPoint,
} from '../../contracts/src/index.ts'
import type { NativeEvent, NativeTransport } from './native-transport.ts'

interface Authority {
  readonly view: ViewHandle
  readonly window: WindowHandle
  readonly id: number
  readonly scope: object
}
interface Subscription {
  readonly listener: (event: WindowCommandsEvent) => void
  readonly stop: () => void
  active: boolean
}
interface Registration {
  readonly handle: WindowCommandsHandle
  readonly scope: PolicyScope
  readonly authority: Authority
  readonly definition: WindowCommandsDefinition
  readonly menuCommands: ReadonlySet<string>
  readonly listeners: Set<Subscription>
  removeAbort: () => void
  active: boolean
  created: boolean
  sequence: number
  nextPopup: number
  popup:
    | { readonly id: number; readonly removeAbort: () => void; cancelled: boolean; shown: boolean }
    | undefined
  disposal: Promise<void> | undefined
}
function nativeError(error: unknown): never {
  if (error instanceof Error)
    for (const code of [
      'INVALID_ARGUMENT',
      'INVALID_HANDLE',
      'DISPOSED',
      'PERMISSION_DENIED',
      'RESOURCE_IN_USE',
      'UNSUPPORTED_CAPABILITY',
    ] as const)
      if (error.message.startsWith(`${code}:`)) throw new BunlyError(code, error.message)
  throw error
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

/** Private bounded resource owner. Native events never provide new authority. */
export class CefWindowCommands {
  readonly #handles = new WeakMap<WindowCommandsHandle, Registration>()
  readonly #registrations = new Map<string, Registration>()
  #closed = false
  constructor(
    readonly transport: NativeTransport,
    readonly capture: (scope: PolicyScope) => Authority,
    readonly available: () => void,
    readonly listenerError: () => void
  ) {}
  #check(record: Registration): void {
    this.available()
    if (!record.active || this.#closed) throw new BunlyError('DISPOSED', 'Window commands disposed')
    const current = this.capture(record.scope)
    if (current.id !== record.authority.id || current.window !== record.authority.window)
      throw new BunlyError('PERMISSION_DENIED', 'Window command authority changed')
  }
  #record(handle: WindowCommandsHandle): Registration {
    if (!handle || typeof handle !== 'object')
      throw new BunlyError('INVALID_HANDLE', 'Foreign window command handle')
    const record = this.#handles.get(handle)
    if (!record) throw new BunlyError('INVALID_HANDLE', 'Foreign window command handle')
    return record
  }
  #args(record: Registration): Record<string, unknown> {
    return { registration: record.handle.id, scope: record.authority.scope }
  }
  async #call(record: Registration, operation: string, args: object = {}): Promise<unknown> {
    try {
      return await this.transport.call(operation, { ...this.#args(record), ...args })
    } catch (error) {
      return nativeError(error)
    }
  }
  async create(
    scope: PolicyScope,
    input: WindowCommandsDefinition,
    options?: OperationOptions
  ): Promise<WindowCommandsHandle> {
    this.available()
    const signal = options?.signal
    signal?.throwIfAborted()
    const definition = normalizeWindowCommands(input)
    signal?.throwIfAborted()
    this.available()
    const authority = this.capture(scope)
    const siblings = [...this.#registrations.values()].filter(
      (record) => record.authority.window === authority.window
    )
    if (
      this.#closed ||
      this.#registrations.size >= WINDOW_COMMAND_LIMITS.registrations ||
      siblings.length >= WINDOW_COMMAND_LIMITS.registrationsPerWindow
    )
      throw new BunlyError('RESOURCE_IN_USE', 'Window command registration capacity exceeded')
    const chords = new Set(
      siblings.flatMap((record) =>
        record.definition.commands.flatMap((command) =>
          command.shortcut ? [windowShortcutKey(command.shortcut)] : []
        )
      )
    )
    if (
      definition.commands.some(
        (command) => command.shortcut && chords.has(windowShortcutKey(command.shortcut))
      )
    )
      throw new BunlyError('RESOURCE_IN_USE', 'Shortcut is already registered in this window')
    const handle = Object.freeze({
      id: crypto.randomUUID().replaceAll('-', ''),
    }) as WindowCommandsHandle
    const menuCommands = new Set<string>()
    const collect = (items: WindowCommandsDefinition['menu']) => {
      for (const item of items) {
        if (item.type === 'command') menuCommands.add(item.command)
        else if (item.type === 'submenu') collect(item.items)
      }
    }
    collect(definition.menu)
    const record: Registration = {
      handle,
      scope,
      authority,
      definition,
      menuCommands,
      listeners: new Set(),
      removeAbort: () => {},
      active: true,
      created: false,
      sequence: 0,
      nextPopup: 0,
      popup: undefined,
      disposal: undefined,
    }
    // Install before writing: a native callback and its creation reply can share a pipe read.
    this.#handles.set(handle, record)
    this.#registrations.set(handle.id, record)
    const aborted = () => {
      this.#deactivate(record)
      // Creation remains charged until the native reply. Its continuation performs release.
      if (record.created) this.#cleanup(record)
    }
    signal?.addEventListener('abort', aborted, { once: true })
    record.removeAbort = () => signal?.removeEventListener('abort', aborted)
    try {
      signal?.throwIfAborted()
      this.#check(record)
      const result = await this.#call(record, 'commands.create', { definition })
      record.created = true
      if (result !== null) throw new Error('Malformed native window command creation receipt')
      signal?.throwIfAborted()
      this.#check(record)
      return handle
    } catch (error) {
      this.#deactivate(record)
      if (record.created) await this.dispose(handle)
      // A failed control channel cannot prove that native creation did not run.
      // Keep its finite reservation as unknown ownership instead of reporting zero.
      else if (!this.transport.failure) this.#forget(record)
      throw error
    }
  }
  async show(
    handle: WindowCommandsHandle,
    point: WindowMenuPoint,
    options?: OperationOptions
  ): Promise<void> {
    const record = this.#record(handle)
    this.#check(record)
    const signal = options?.signal
    signal?.throwIfAborted()
    const ownedPoint = { ...point }
    validateWindowMenuPoint(ownedPoint)
    signal?.throwIfAborted()
    this.#check(record)
    if (!record.definition.menu.length)
      throw new BunlyError('INVALID_ARGUMENT', 'This registration has no popup menu')
    if (record.popup)
      throw new BunlyError('RESOURCE_IN_USE', 'This registration already has a pending popup')
    if (record.nextPopup === Number.MAX_SAFE_INTEGER)
      throw new BunlyError('RESOURCE_IN_USE', 'Window menu identity exhausted')
    const id = ++record.nextPopup
    const aborted = () => {
      if (record.popup?.id === id) {
        record.popup.cancelled = true
        void this.#cancel(record, id).catch((error: unknown) => this.transport.fail(error))
      }
    }
    const popup = {
      id,
      cancelled: false,
      shown: false,
      removeAbort: () => signal?.removeEventListener('abort', aborted),
    }
    record.popup = popup
    signal?.addEventListener('abort', aborted, { once: true })
    try {
      signal?.throwIfAborted()
      this.#check(record)
      // The owned signal cancels the matching native popup, not the admission receipt.
      const result = await this.#call(record, 'commands.show', { popup: id, point: ownedPoint })
      if (result !== null) throw new Error('Malformed native menu admission receipt')
      signal?.throwIfAborted()
      this.#check(record)
    } catch (error) {
      if (record.popup === popup) {
        await this.#cancel(record, id)
      }
      throw error
    }
  }
  #clearPopup(record: Registration): void {
    record.popup?.removeAbort()
    record.popup = undefined
  }
  async #cancel(record: Registration, popup: number): Promise<void> {
    if (record.popup?.id === popup) record.popup.cancelled = true
    const result = await this.#call(record, 'commands.cancel', { popup })
    if (
      !result ||
      typeof result !== 'object' ||
      Object.keys(result).length !== 1 ||
      !('pending' in result) ||
      typeof result.pending !== 'boolean'
    )
      throw new Error('Malformed native menu cancellation receipt')
    // On macOS CancelMenu requests the nested menu loop to unwind. Keep the
    // popup charged until its actual MenuClosed callback (or explicit absence).
    if (!result.pending && record.popup?.id === popup) this.#clearPopup(record)
  }
  async cancel(handle: WindowCommandsHandle): Promise<void> {
    const record = this.#record(handle)
    this.#check(record)
    if (record.popup) await this.#cancel(record, record.popup.id)
  }
  onEvent(
    handle: WindowCommandsHandle,
    listener: (event: WindowCommandsEvent) => void,
    options?: OperationOptions
  ): () => void {
    const record = this.#record(handle)
    this.#check(record)
    options?.signal?.throwIfAborted()
    if (typeof listener !== 'function') throw new BunlyError('INVALID_ARGUMENT', 'Invalid listener')
    if (record.listeners.size >= WINDOW_COMMAND_LIMITS.listeners)
      throw new BunlyError('RESOURCE_IN_USE', 'Window command listener capacity exceeded')
    const subscription: Subscription = {
      listener,
      active: true,
      stop: () => {
        subscription.active = false
        record.listeners.delete(subscription)
        options?.signal?.removeEventListener('abort', subscription.stop)
      },
    }
    record.listeners.add(subscription)
    options?.signal?.addEventListener('abort', subscription.stop, { once: true })
    return subscription.stop
  }
  #deactivate(record: Registration): void {
    record.active = false
    record.removeAbort()
    this.#clearPopup(record)
    for (const subscription of record.listeners) subscription.stop()
  }
  #forget(record: Registration): void {
    this.#deactivate(record)
    this.#registrations.delete(record.handle.id)
  }
  #cleanup(record: Registration): void {
    void this.dispose(record.handle).catch((error: unknown) => this.transport.fail(error))
  }
  dispose(handle: WindowCommandsHandle): Promise<void> {
    const record = this.#record(handle)
    this.#deactivate(record)
    if (record.disposal) return record.disposal
    if (!this.#registrations.has(handle.id)) return Promise.resolve()
    const release = this.#closed
      ? this.transport.closed.then(() => {
          if (this.transport.failure) throw this.transport.failure
          return null
        })
      : this.#call(record, 'commands.dispose')
    record.disposal = release
      .then((result) => {
        if (result !== null) throw new Error('Malformed native window command disposal receipt')
        this.#forget(record)
      })
      .catch((error: unknown) => {
        record.disposal = undefined
        throw error
      })
    return record.disposal
  }
  /** Managed owner accepts only the exact captured scope that created this resource. */
  matchesScope(handle: WindowCommandsHandle, scope: PolicyScope): boolean {
    const record = this.#record(handle)
    this.#check(record)
    if (record.scope === scope) return true
    const current = this.capture(scope)
    return (
      current.view === record.authority.view &&
      JSON.stringify(current.scope) === JSON.stringify(record.authority.scope)
    )
  }
  retireView(view: ViewHandle): void {
    for (const record of this.#registrations.values())
      if (record.authority.view === view && record.active) {
        this.#deactivate(record)
        if (record.created) this.#cleanup(record)
      }
  }
  stop(): void {
    this.#closed = true
    for (const record of this.#registrations.values()) this.#deactivate(record)
  }
  close(): void {
    this.stop()
    // EOF/failure does not attest native release. Preserve the finite reservation
    // and make explicit disposal reject; a clean native shutdown releases it.
    if (!this.transport.failure)
      for (const record of this.#registrations.values()) this.#forget(record)
  }
  get listenerCount(): number {
    let count = 0
    for (const record of this.#registrations.values()) count += record.listeners.size
    return count
  }
  diagnostics() {
    return Object.freeze({
      registrations: this.#registrations.size,
      listeners: this.listenerCount,
      popups: [...this.#registrations.values()].filter((record) => record.popup).length,
    })
  }
  event(frame: NativeEvent): void {
    if (frame.event !== 'window.commands') return
    const data = frame.data
    if (
      !data ||
      !/^[a-f0-9]{32}$/.test(String(data['registration'])) ||
      !integer(frame.target) ||
      !integer(data['sequence'])
    )
      throw new Error('Malformed native window command event')
    const record = this.#registrations.get(String(data['registration']))
    if (!record || !record.active) return
    if (frame.target !== record.authority.id || Number(data['sequence']) <= record.sequence)
      throw new Error('Invalid native window command event identity or order')
    record.sequence = Number(data['sequence'])
    const type = data['type']
    let event: WindowCommandsEvent
    if (type === 'command') {
      const source = data['source']
      const command = record.definition.commands.find((command) => command.id === data['command'])
      if (
        !command ||
        command.enabled === false ||
        (source !== 'shortcut' && source !== 'menu') ||
        (source === 'shortcut' && !command.shortcut) ||
        (source === 'menu' && !record.menuCommands.has(command.id)) ||
        Object.keys(data).length !== (source === 'menu' ? 6 : 5)
      )
        throw new Error('Invalid native command callback')
      if (source === 'menu' && (data['popup'] !== record.popup?.id || record.popup?.cancelled))
        return
      if (source === 'menu' && !record.popup?.shown)
        throw new Error('Native menu command preceded visibility')
      event = Object.freeze({
        type,
        sequence: Number(data['sequence']),
        command: command.id,
        source,
      })
    } else if (type === 'menu-shown' || type === 'menu-closed' || type === 'menu-failed') {
      if (Object.keys(data).length !== 4 || !integer(data['popup']))
        throw new Error('Malformed native popup event')
      if (data['popup'] !== record.popup?.id) return
      if (type === 'menu-shown') {
        if (record.popup!.shown) throw new Error('Duplicate native menu visibility event')
        record.popup!.shown = true
      }
      event = Object.freeze({ type, sequence: Number(data['sequence']) })
      if (type === 'menu-closed' || type === 'menu-failed') this.#clearPopup(record)
    } else if (type === 'revoked' && Object.keys(data).length === 3) {
      event = Object.freeze({ type, sequence: Number(data['sequence']) })
    } else throw new Error('Unknown native window command event')
    record.sequence = event.sequence
    // Revocation is a lifetime receipt. It carries no command authority or application data.
    if (type !== 'revoked') {
      try {
        this.#check(record)
      } catch {
        this.#deactivate(record)
        this.#cleanup(record)
        return
      }
    }
    for (const subscription of Array.from(record.listeners)) {
      if (!subscription.active || !record.active) continue
      try {
        // A previous listener may synchronously navigate, abort, dispose, or shut down.
        if (type !== 'revoked') this.#check(record)
      } catch {
        break
      }
      try {
        subscription.listener(event)
      } catch {
        this.listenerError()
      }
    }
    if (type === 'revoked') {
      this.#deactivate(record)
      if (record.created) this.#cleanup(record)
    }
  }
  async qualify(
    handle: WindowCommandsHandle,
    action: 'shortcut' | 'select-first',
    command?: string
  ): Promise<void> {
    const record = this.#record(handle)
    this.#check(record)
    const result = await this.#call(record, 'commands.qualification', {
      action,
      ...(command ? { command } : {}),
    })
    if (result !== null) throw new Error('Malformed native window command qualification receipt')
    this.#check(record)
  }
}

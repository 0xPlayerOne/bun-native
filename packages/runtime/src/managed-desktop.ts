import type {
  Bounds,
  RuntimeEvent,
  SessionHandle,
  ViewHandle,
  WindowHandle,
  WindowCommandsHandle,
  WindowMenuPoint,
  StatusItemHandle,
  ApplicationLinkReader,
  ApplicationLinkBatch,
} from '../../contracts/src/index.ts'
import {
  normalizeViewPresentation,
  validateBounds,
  validateWindowMenuPoint,
  normalizeStatusItem,
} from '../../contracts/src/index.ts'
import { validateClipboardText } from '../../contracts/src/desktop.ts'
import { normalizeFileDialog } from '../../contracts/src/dialogs.ts'
import type { CefBackend, PolicyScope } from './cef.ts'
import {
  ManagedError,
  ManagedGenerationOwner,
  type ManagedCallContext,
  type ManagedGeneration,
  type ManagedResource,
  type ManagedResourceKind,
} from './managed-generations.ts'
import type { TerminalHandle, TerminalService } from './terminal.ts'
import type { ServiceSupervisor } from './service-supervisor.ts'

declare const authorityBrand: unique symbol
/** Stable-host capability. Neither this token nor native handles enter a replacement Worker. */
export interface ManagedDesktopAuthority {
  readonly [authorityBrand]: true
}
export interface ManagedDesktopPolicy {
  readonly authority: ManagedDesktopAuthority
  readonly permission: string
  readonly operations: readonly string[]
  readonly dependsOn?: readonly ManagedResource[]
  /** Optional current host policy. Only literal true permits attachment or operation. */
  readonly authorize?: (operation: string) => boolean
}
export interface ManagedDesktopBinding {
  readonly resource: ManagedResource
  readonly schema: string
  /** Stable-host precommit reauthorization; never transferred to application code. */
  readonly validate: () => Promise<void>
  readonly current: () => boolean
}
interface Authority {
  readonly view: ViewHandle
  readonly document: string
  readonly origin: string
  readonly scope: PolicyScope
}
interface EventRecord {
  readonly sequence: number
  readonly type: string
  readonly state?: unknown
  readonly bounds?: Bounds
  readonly completed?: boolean
}
interface Entry {
  readonly name: string
  readonly kind: ManagedResourceKind
  readonly authority: Authority
  readonly operations: ReadonlySet<string>
  readonly policy: ((operation: string) => boolean) | undefined
  readonly binding: ManagedDesktopBinding
  readonly handle: object
  readonly events: EventRecord[]
  eventBytes: number
  eventSequence: number
  eventOverflow: boolean
  lastRead: { generation: ManagedGeneration; sequence: number } | undefined
  closed: boolean
  disposal: Promise<void> | undefined
}
const lifecycleOperations = ['events', 'ack-events']
const operations = {
  window: [
    'state',
    'show',
    'resize',
    'activate',
    'minimize',
    'restore',
    'maximize',
    'fullscreen',
    'bounds',
    'set-bounds',
  ],
  view: ['state', 'navigate', 'focus', 'presentation', 'present'],
  session: ['identity', 'cookies', 'flush'],
  terminal: ['identity', 'write', 'resize', 'signal'],
  process: ['state', 'write', 'resize', 'signal'],
  clipboard: ['read-text', 'write-text', 'clear'],
  commands: ['show', 'cancel'],
  'status-item': ['update'],
  'application-links': [],
  dialog: ['open', 'save'],
} as const
const signals = new Set([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGTERM',
  'SIGKILL',
  'SIGUSR1',
  'SIGUSR2',
  'SIGWINCH',
])
function invalid(): never {
  throw new ManagedError('INVALID_ARGUMENT')
}
function object(input: string, keys: readonly string[]): Record<string, unknown> {
  const value: unknown = JSON.parse(input)
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).sort().join(',') !== [...keys].sort().join(',')) invalid()
  return result
}
function empty(input: string): void {
  if (JSON.parse(input) !== null) invalid()
}
function dimension(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000) invalid()
  return Number(value)
}
function textInput(input: string): Uint8Array {
  const value = object(input, ['text'])['text']
  if (typeof value !== 'string' || value.length > 16384) invalid()
  const bytes = new TextEncoder().encode(value)
  if (!bytes.length || bytes.length > 16384) invalid()
  return bytes
}
function signalInput(input: string): NodeJS.Signals {
  const value = object(input, ['signal'])['signal']
  if (typeof value !== 'string' || !signals.has(value)) invalid()
  return value as NodeJS.Signals
}

/** Concrete owner adapters. Registration retains resources; preparation never recreates them.
 * Terminal output stays on its original bounded writer, independently of application generations.
 */
export class ManagedDesktopResources {
  readonly #entries = new Map<string, Entry>()
  readonly #entriesByHandle = new WeakMap<object, Entry>()
  readonly #authorities = new WeakMap<ManagedDesktopAuthority, Authority>()
  readonly #stopEvents: () => void
  readonly #maxEvents: number
  readonly #maxEventBytes: number
  #closed = false
  constructor(
    readonly owner: ManagedGenerationOwner,
    readonly backend: CefBackend,
    options: { readonly maxEvents?: number; readonly maxEventBytes?: number } = {}
  ) {
    this.#maxEvents = options.maxEvents ?? 64
    this.#maxEventBytes = options.maxEventBytes ?? 32768
    if (
      !Number.isSafeInteger(this.#maxEvents) ||
      this.#maxEvents < 1 ||
      this.#maxEvents > 1024 ||
      !Number.isSafeInteger(this.#maxEventBytes) ||
      this.#maxEventBytes < 256 ||
      this.#maxEventBytes > 65536
    )
      invalid()
    this.#stopEvents = backend.onEvent((event) => this.#event(event))
    const retired = () => {
      void this.dispose().catch(() => {})
    }
    void backend.closed.then(retired, retired)
  }
  async captureAuthority(view: ViewHandle): Promise<ManagedDesktopAuthority> {
    if (this.#closed) throw new ManagedError('DISPOSED')
    const state = this.backend.state(view)
    if (state.trust.kind !== 'application') throw new ManagedError('DENIED')
    const scope = await this.backend.capturePolicyScope(view)
    const current = this.backend.state(view)
    if (
      this.#closed ||
      current.documentId !== state.documentId ||
      current.trust.kind !== 'application' ||
      current.trust.origin !== state.trust.origin
    )
      throw new ManagedError('DENIED')
    const authority = Object.freeze({}) as ManagedDesktopAuthority
    this.#authorities.set(authority, {
      view,
      scope,
      document: state.documentId,
      origin: state.trust.origin,
    })
    return authority
  }
  #current(entry: Entry, operation: string): boolean {
    if (
      this.#closed ||
      entry.closed ||
      (operation !== 'attach' && !entry.operations.has(operation))
    )
      return false
    try {
      if (
        entry.kind === 'commands' &&
        !this.backend.windowCommandsMatchScope(
          entry.handle as WindowCommandsHandle,
          entry.authority.scope
        )
      )
        return false
      if (
        entry.kind === 'status-item' &&
        !this.backend.statusItemMatchesScope(
          entry.handle as StatusItemHandle,
          entry.authority.scope
        )
      )
        return false
      if (
        entry.kind === 'application-links' &&
        !this.backend.applicationLinkReaderMatchesScope(
          entry.handle as ApplicationLinkReader,
          entry.authority.scope
        )
      )
        return false
      if (entry.policy) {
        const result: unknown = entry.policy(operation)
        if (result !== true) {
          // A mistakenly async policy never grants authority or leaks a rejected promise.
          if (result && typeof result === 'object' && 'then' in result)
            void Promise.resolve(result).catch(() => {})
          return false
        }
      }
      const state = this.backend.state(entry.authority.view)
      return (
        !this.#closed &&
        !entry.closed &&
        this.backend.isPolicyScopeLocallyCurrent(entry.authority.scope) &&
        state.documentId === entry.authority.document &&
        state.trust.kind === 'application' &&
        state.trust.origin === entry.authority.origin
      )
    } catch {
      return false
    }
  }
  async #validate(entry: Entry, operation: string, context?: ManagedCallContext): Promise<void> {
    const check = () => {
      if (!this.#current(entry, operation)) throw new ManagedError('DENIED')
      if (context && (!context.isCurrent() || context.signal.aborted))
        throw new ManagedError('RETIRED')
    }
    check()
    try {
      await this.backend.validatePolicyScope(entry.authority.scope)
    } catch {
      throw new ManagedError('DENIED')
    }
    check()
  }
  #register(
    name: string,
    kind: ManagedResourceKind,
    handle: object,
    policy: ManagedDesktopPolicy,
    invoke: (
      operation: string,
      input: string,
      context: ManagedCallContext
    ) => unknown | Promise<unknown>,
    dispose: () => Promise<void>,
    refreshEvents?: () => Promise<void>
  ): Entry {
    if (this.#closed) throw new ManagedError('DISPOSED')
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) || this.#entries.has(name)) invalid()
    if (this.#entriesByHandle.has(handle)) throw new ManagedError('INVALID_IDENTITY')
    const authority = this.#authorities.get(policy.authority)
    if (!authority) throw new ManagedError('DENIED')
    if (
      !Array.isArray(policy.operations) ||
      policy.operations.length < 1 ||
      policy.operations.length > 16 ||
      (policy.authorize !== undefined && typeof policy.authorize !== 'function')
    )
      invalid()
    const allowed = new Set<string>([
      ...operations[kind],
      ...(['window', 'view', 'session', 'commands', 'status-item', 'application-links'].includes(
        kind
      )
        ? lifecycleOperations
        : []),
    ])
    const selected = new Set<string>()
    for (const operation of policy.operations) {
      if (!allowed.has(operation) || selected.has(operation)) invalid()
      selected.add(operation)
    }
    let entry!: Entry
    const schema = `bunly.${kind}:1`
    const resource = this.owner.register({
      kind,
      schema,
      permission: policy.permission,
      ...(policy.dependsOn ? { dependsOn: policy.dependsOn } : {}),
      authorize: (operation) => this.#current(entry, operation),
      invoke: async (operation, input, context) => {
        await this.#validate(entry, operation, context)
        if (!this.#current(entry, operation)) throw new ManagedError('DENIED')
        if (!context.isCurrent() || context.signal.aborted) throw new ManagedError('RETIRED')
        let result: unknown
        if (operation === 'events') {
          empty(input)
          if (entry.eventOverflow) throw new ManagedError('CAPACITY')
          if (refreshEvents) {
            await refreshEvents()
            if (!this.#current(entry, operation)) throw new ManagedError('DENIED')
            if (!context.isCurrent() || context.signal.aborted) throw new ManagedError('RETIRED')
          }
          const events = entry.events.map((event) => structuredClone(event))
          if (events.length)
            entry.lastRead = { generation: context.generation, sequence: events.at(-1)!.sequence }
          result = events
        } else if (operation === 'ack-events') {
          const through = object(input, ['through'])['through']
          if (
            !Number.isSafeInteger(through) ||
            Number(through) < 1 ||
            !entry.lastRead ||
            entry.lastRead.generation !== context.generation ||
            entry.lastRead.sequence !== through
          )
            invalid()
          while (entry.events.length && entry.events[0]!.sequence <= Number(through)) {
            const event = entry.events.shift()!
            entry.eventBytes -= Buffer.byteLength(JSON.stringify(event))
          }
          entry.lastRead = undefined
          result = null
        } else result = await invoke(operation, input, context)
        if (!this.#current(entry, operation)) throw new ManagedError('DENIED')
        if (!context.isCurrent() || context.signal.aborted) throw new ManagedError('RETIRED')
        return JSON.stringify(result)
      },
      dispose: async () => {
        entry.closed = true
        await dispose()
        entry.events.length = 0
        entry.eventBytes = 0
        entry.lastRead = undefined
        this.#entriesByHandle.delete(handle)
        if (this.#entries.get(name) === entry) this.#entries.delete(name)
      },
    })
    entry = {
      name,
      kind,
      authority,
      handle,
      operations: selected,
      policy: policy.authorize,
      binding: Object.freeze({
        resource,
        schema,
        validate: () => this.#validate(entry, 'attach'),
        current: () => this.#current(entry, 'attach'),
      }),
      events: [],
      eventBytes: 0,
      eventSequence: 0,
      eventOverflow: false,
      lastRead: undefined,
      closed: false,
      disposal: undefined,
    }
    this.#entries.set(name, entry)
    this.#entriesByHandle.set(handle, entry)
    return entry
  }
  /** Owns the scoped adapter binding, never clipboard contents placed by another application. */
  registerClipboard(name: string, policy: ManagedDesktopPolicy): ManagedResource {
    const authority = this.#authorities.get(policy.authority)
    if (!authority) throw new ManagedError('DENIED')
    return this.#register(
      name,
      'clipboard',
      Object.freeze({}),
      policy,
      async (operation, input, context) => {
        if (operation === 'read-text') {
          empty(input)
          return this.backend.readClipboardText(authority.scope, { signal: context.signal })
        }
        if (operation === 'write-text') {
          const text = object(input, ['text'])['text']
          try {
            validateClipboardText(text)
          } catch {
            invalid()
          }
          await this.backend.writeClipboardText(authority.scope, text, { signal: context.signal })
          return null
        }
        if (operation === 'clear') {
          empty(input)
          await this.backend.clearClipboard(authority.scope, { signal: context.signal })
          return null
        }
        invalid()
      },
      async () => {}
    ).binding.resource
  }
  /** Stable owner receives native events; generations consume the bounded authorized journal. */
  registerWindowCommands(
    name: string,
    commands: WindowCommandsHandle,
    policy: ManagedDesktopPolicy
  ): ManagedResource {
    const authority = this.#authorities.get(policy.authority)
    if (!authority || !this.backend.windowCommandsMatchScope(commands, authority.scope))
      throw new ManagedError('DENIED')
    let stop = () => {}
    const entry = this.#register(
      name,
      'commands',
      commands,
      policy,
      async (operation, input, context) => {
        if (operation === 'show') {
          const point = object(input, ['x', 'y']) as unknown as WindowMenuPoint
          try {
            validateWindowMenuPoint(point)
          } catch {
            invalid()
          }
          await this.backend.showWindowMenu(commands, point, { signal: context.signal })
        } else if (operation === 'cancel') {
          empty(input)
          await this.backend.cancelWindowMenu(commands)
        } else invalid()
        return null
      },
      async () => {
        stop()
        await this.backend.disposeWindowCommands(commands)
      }
    )
    try {
      stop = this.backend.onWindowCommandsEvent(commands, (event) => {
        if (event.type === 'revoked') {
          void this.#close(entry)
          return
        }
        if (!this.#current(entry, 'events')) return
        this.#appendEvent(entry, {
          sequence: ++entry.eventSequence,
          type: event.type,
          state: event,
        })
      })
    } catch (error) {
      void this.#close(entry)
      throw error
    }
    return entry.binding.resource
  }
  /** The stable owner retains the item; generations consume its bounded click journal. */
  registerStatusItem(
    name: string,
    item: StatusItemHandle,
    policy: ManagedDesktopPolicy
  ): ManagedResource {
    const authority = this.#authorities.get(policy.authority)
    if (!authority || !this.backend.statusItemMatchesScope(item, authority.scope))
      throw new ManagedError('DENIED')
    let stop = () => {}
    const entry = this.#register(
      name,
      'status-item',
      item,
      policy,
      async (operation, input) => {
        if (operation !== 'update') invalid()
        let definition
        try {
          definition = normalizeStatusItem(JSON.parse(input))
        } catch {
          invalid()
        }
        await this.backend.updateStatusItem(item, definition)
        return null
      },
      async () => {
        stop()
        await this.backend.disposeStatusItem(item)
      }
    )
    try {
      stop = this.backend.onStatusItemEvent(item, (event) => {
        if (event.type === 'revoked') {
          void this.#close(entry)
          return
        }
        if (!this.#current(entry, 'events')) return
        this.#appendEvent(entry, {
          sequence: ++entry.eventSequence,
          type: event.type,
          state: event,
        })
      })
    } catch (error) {
      void this.#close(entry)
      throw error
    }
    return entry.binding.resource
  }
  /** Native delivery transfers into the stable host journal before native ACK.
   * Worker retirement never owns that transfer and cannot erase its result.
   */
  registerApplicationLinks(
    name: string,
    reader: ApplicationLinkReader,
    policy: ManagedDesktopPolicy
  ): ManagedResource {
    const authority = this.#authorities.get(policy.authority)
    if (!authority || !this.backend.applicationLinkReaderMatchesScope(reader, authority.scope))
      throw new ManagedError('DENIED')
    let entry!: Entry
    let pending: Promise<void> | undefined
    let pendingBatch: ApplicationLinkBatch | undefined
    const refresh = (): Promise<void> => {
      if (pending) return pending
      pending = (async () => {
        if (pendingBatch) {
          await this.backend.acknowledgeApplicationLinks(reader, pendingBatch)
          pendingBatch = undefined
        }
        const batch = await this.backend.readApplicationLinks(reader)
        if (!this.#current(entry, 'events')) throw new ManagedError('DENIED')
        const additions: EventRecord[] = batch.links.map((link, index) => ({
          sequence: entry.eventSequence + index + 1,
          type: 'link',
          state: link,
        }))
        if (batch.overflow)
          additions.push({
            sequence: entry.eventSequence + additions.length + 1,
            type: 'overflow',
            state: { dropped: batch.overflow },
          })
        const bytes = additions.reduce(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
          0
        )
        if (
          entry.events.length + additions.length > this.#maxEvents ||
          entry.eventBytes + bytes > this.#maxEventBytes ||
          !Number.isSafeInteger(entry.eventSequence + additions.length)
        )
          throw new ManagedError('CAPACITY')
        // Commit the whole read before the destructive native ACK. If ACK fails,
        // keep its authentic receipt and retry it before reading another batch.
        entry.events.push(...additions)
        entry.eventBytes += bytes
        entry.eventSequence += additions.length
        pendingBatch = batch
        await this.backend.acknowledgeApplicationLinks(reader, batch)
        pendingBatch = undefined
      })().finally(() => {
        pending = undefined
      })
      return pending
    }
    entry = this.#register(
      name,
      'application-links',
      reader,
      policy,
      () => invalid(),
      async () => {
        await this.backend.disposeApplicationLinkReader(reader)
        pendingBatch = undefined
      },
      refresh
    )
    return entry.binding.resource
  }
  /** A generation owns each pending selection and cancels it before retiring. */
  registerFileDialogs(name: string, policy: ManagedDesktopPolicy): ManagedResource {
    const authority = this.#authorities.get(policy.authority)
    if (!authority) throw new ManagedError('DENIED')
    return this.#register(
      name,
      'dialog',
      Object.freeze({}),
      policy,
      async (operation, input, context) => {
        if (operation !== 'open' && operation !== 'save') invalid()
        let dialog
        try {
          dialog = normalizeFileDialog(operation, JSON.parse(input))
        } catch {
          invalid()
        }
        const options = { signal: context.signal }
        return operation === 'open'
          ? this.backend.showOpenFileDialog(
              authority.scope,
              { title: dialog.title, directory: dialog.directory },
              options
            )
          : this.backend.showSaveFileDialog(authority.scope, dialog, options)
      },
      async () => {}
    ).binding.resource
  }
  registerWindow(
    name: string,
    window: WindowHandle,
    policy: ManagedDesktopPolicy
  ): ManagedResource {
    return this.#register(
      name,
      'window',
      window,
      policy,
      async (operation, input, context) => {
        if (operation === 'show') {
          const visible = object(input, ['visible'])['visible']
          if (typeof visible !== 'boolean') invalid()
          await this.backend.showWindow(window, visible, { signal: context.signal })
        } else if (operation === 'resize') {
          const value = object(input, ['width', 'height'])
          const width = value['width'],
            height = value['height']
          if (
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            Number(width) < 1 ||
            Number(height) < 1 ||
            Number(width) > 16384 ||
            Number(height) > 16384
          )
            invalid()
          await this.backend.resizeWindow(window, Number(width), Number(height), {
            signal: context.signal,
          })
        } else if (operation === 'fullscreen') {
          const fullscreen = object(input, ['fullscreen'])['fullscreen']
          if (typeof fullscreen !== 'boolean') invalid()
          return this.backend.setWindowFullscreen(window, fullscreen, { signal: context.signal })
        } else if (operation === 'set-bounds') {
          const bounds = object(input, ['x', 'y', 'width', 'height']) as unknown as Bounds
          try {
            validateBounds(bounds)
          } catch {
            invalid()
          }
          if (bounds.width > 16384 || bounds.height > 16384) invalid()
          return this.backend.setWindowBounds(window, bounds, { signal: context.signal })
        } else {
          empty(input)
          const options = { signal: context.signal }
          if (operation === 'state') return this.backend.windowState(window, options)
          if (operation === 'activate') return this.backend.activateWindow(window, options)
          if (operation === 'minimize') return this.backend.minimizeWindow(window, options)
          if (operation === 'restore') return this.backend.restoreWindow(window, options)
          if (operation === 'maximize') return this.backend.maximizeWindow(window, options)
          if (operation === 'bounds') return this.backend.windowBounds(window, options)
          invalid()
        }
        return null
      },
      () => this.backend.closeWindow(window)
    ).binding.resource
  }
  registerView(name: string, view: ViewHandle, policy: ManagedDesktopPolicy): ManagedResource {
    return this.#register(
      name,
      'view',
      view,
      policy,
      async (operation, input, context) => {
        if (operation === 'navigate') {
          const url = object(input, ['url'])['url']
          if (typeof url !== 'string' || url.length > 8192) invalid()
          await this.backend.navigate(view, url, { signal: context.signal })
        } else if (operation === 'present') {
          const presentation = normalizeViewPresentation(
            object(input, ['presentation'])['presentation']
          )
          return this.backend.setViewPresentation(view, presentation, { signal: context.signal })
        } else {
          empty(input)
          if (operation === 'state') return this.backend.state(view)
          if (operation === 'presentation')
            return this.backend.viewPresentation(view, { signal: context.signal })
          if (operation === 'focus') await this.backend.focusView(view, { signal: context.signal })
          else invalid()
        }
        return null
      },
      () => this.backend.disposeView(view)
    ).binding.resource
  }
  registerSession(
    name: string,
    session: SessionHandle,
    policy: ManagedDesktopPolicy
  ): ManagedResource {
    return this.#register(
      name,
      'session',
      session,
      policy,
      async (operation, input) => {
        empty(input)
        if (operation === 'identity') return { id: session.id }
        if (operation === 'cookies') return this.backend.cookies(session)
        if (operation === 'flush') {
          await this.backend.flushSession(session)
          return null
        }
        invalid()
      },
      () => this.backend.disposeSession(session)
    ).binding.resource
  }
  registerTerminal(
    name: string,
    service: TerminalService,
    terminal: TerminalHandle,
    policy: ManagedDesktopPolicy
  ): ManagedResource {
    const observation = service.observe(terminal)
    let exited = false
    const entry = this.#register(
      name,
      'terminal',
      terminal,
      policy,
      async (operation, input, context) => {
        if (exited) throw new ManagedError('DISPOSED')
        if (operation === 'identity') {
          empty(input)
          return { id: terminal.id }
        }
        if (operation === 'write')
          await service.write(terminal, textInput(input), { signal: context.signal })
        else if (operation === 'resize') {
          const value = object(input, ['cols', 'rows'])
          service.resize(terminal, dimension(value['cols']), dimension(value['rows']))
        } else if (operation === 'signal') service.signal(terminal, signalInput(input))
        else invalid()
        return null
      },
      async () => {
        if (!exited) {
          const result = await service.close(terminal)
          if (!result.released) throw new ManagedError('CLEANUP_FAILED')
        }
        await observation.released
      }
    )
    void observation.processExited.then(
      () => {
        exited = true
        void this.#close(entry)
      },
      () => {
        void this.#close(entry)
      }
    )
    return entry.binding.resource
  }
  registerProcess(
    name: string,
    supervisor: ServiceSupervisor,
    policy: ManagedDesktopPolicy
  ): ManagedResource {
    const entry = this.#register(
      name,
      'process',
      supervisor,
      policy,
      async (operation, input) => {
        const snapshot = supervisor.snapshot
        if (operation === 'state') {
          empty(input)
          return {
            ...snapshot,
            generation: snapshot.generation ? { attempt: snapshot.generation.attempt } : null,
          }
        }
        if (snapshot.state !== 'ready' || !snapshot.generation) throw new ManagedError('DISPOSED')
        if (operation === 'write') await supervisor.write(snapshot.generation, textInput(input))
        else if (operation === 'resize') {
          const value = object(input, ['cols', 'rows'])
          supervisor.resize(snapshot.generation, dimension(value['cols']), dimension(value['rows']))
        } else if (operation === 'signal')
          supervisor.signal(snapshot.generation, signalInput(input))
        else invalid()
        return null
      },
      async () => {
        supervisor.dispose()
        const final = await supervisor.settled
        if (final.cleanupPending || supervisor.diagnostics().activeGenerations !== 0)
          throw new ManagedError('CLEANUP_FAILED')
      }
    )
    const settled = () => {
      void this.#close(entry)
    }
    void supervisor.settled.then(settled, settled)
    return entry.binding.resource
  }
  /** Run immediately before each reload; closing or stale resources reject the candidate. */
  async prepare(
    names: readonly string[] = [...this.#entries.keys()]
  ): Promise<Readonly<Record<string, ManagedDesktopBinding>>> {
    if (this.#closed) throw new ManagedError('DISPOSED')
    if (!Array.isArray(names) || names.length > 4096 || new Set(names).size !== names.length)
      invalid()
    const entries = names.map((name) => {
      const entry = this.#entries.get(name)
      if (!entry) throw new ManagedError('INVALID_IDENTITY')
      return entry
    })
    for (const entry of entries) await this.#validate(entry, 'attach')
    if (this.#closed) throw new ManagedError('DISPOSED')
    // Earlier resources can close or change policy while a later scope read is pending.
    for (const entry of entries)
      if (!this.#current(entry, 'attach')) throw new ManagedError('DENIED')
    return Object.freeze(Object.fromEntries(entries.map((entry) => [entry.name, entry.binding])))
  }
  #event(event: RuntimeEvent): void {
    const entry = this.#entriesByHandle.get(event.resource)
    if (!entry || entry.closed) return
    if (event.type === 'disposed') {
      this.#close(entry)
      return
    }
    if (!entry.operations.has('events') || entry.eventOverflow) return
    const item: EventRecord = {
      sequence: ++entry.eventSequence,
      type: event.type,
      ...('state' in event ? { state: structuredClone(event.state) } : {}),
      ...(event.type === 'window-bounds-changed' ? { bounds: structuredClone(event.bounds) } : {}),
      ...(event.type === 'window-fullscreen-transition' ? { completed: event.completed } : {}),
    }
    this.#appendEvent(entry, item)
  }
  #appendEvent(entry: Entry, item: EventRecord): void {
    if (entry.closed || entry.eventOverflow || !entry.operations.has('events')) return
    const bytes = Buffer.byteLength(JSON.stringify(item))
    if (entry.events.length >= this.#maxEvents || entry.eventBytes + bytes > this.#maxEventBytes) {
      entry.eventOverflow = true
      return
    }
    entry.events.push(item)
    entry.eventBytes += bytes
  }
  #close(entry: Entry): Promise<void> {
    entry.closed = true
    entry.disposal ??= this.owner.disposeResource(entry.binding.resource)
    void entry.disposal.catch(() => {})
    return entry.disposal
  }
  close(name: string): Promise<void> {
    const entry = this.#entries.get(name)
    if (!entry) return Promise.reject(new ManagedError('INVALID_IDENTITY'))
    return this.#close(entry)
  }
  async dispose(): Promise<void> {
    this.#closed = true
    this.#stopEvents()
    await Promise.all([...this.#entries.values()].map((entry) => this.#close(entry)))
  }
  diagnostics() {
    const entries = [...this.#entries.values()]
    return Object.freeze({
      resources: entries.length,
      listener: this.#closed ? 0 : 1,
      queuedEvents: entries.reduce((n, e) => n + e.events.length, 0),
      queuedEventBytes: entries.reduce((n, e) => n + e.eventBytes, 0),
      eventOverflows: entries.filter((e) => e.eventOverflow).length,
      closed: this.#closed,
    })
  }
}

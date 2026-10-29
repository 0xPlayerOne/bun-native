import {
  BunlyError,
  CONTRACT_VERSION,
  PROFILE_CAPABILITY_VERSION,
  normalizeUrl,
  originOf,
  requireCapability,
  validateBounds,
} from '../../contracts/src/index.ts'
import type {
  BackendDescriptor,
  RendererConsoleBackend,
  Bounds,
  BrowserBackend,
  ClipboardBackend,
  WindowCommandsBackend,
  WindowCommandsDefinition,
  WindowCommandsHandle,
  WindowCommandsEvent,
  WindowMenuPoint,
  ApplicationLinksBackend,
  ApplicationLinkReader,
  ApplicationLinkBatch,
  StatusItemBackend,
  StatusItemDefinition,
  StatusItemHandle,
  StatusItemEvent,
  ApplicationLifecycleBackend,
  ApplicationState,
  ApplicationEvent,
  PolicyScope,
  Cookie,
  CookieDelete,
  CookieInput,
  CookieQuery,
  Diagnostics,
  DownloadRequest,
  DownloadResult,
  InputAction,
  OperationOptions,
  RuntimeEvent,
  SessionHandle,
  SessionClearOptions,
  SessionClearResult,
  SessionOptions,
  ViewHandle,
  ViewOptions,
  ViewState,
  ViewTrust,
  WindowHandle,
  WindowOptions,
  WindowState,
  WindowEvent,
} from '../../contracts/src/index.ts'
import { Registry } from './registry.ts'
interface ViewRecord {
  window: WindowHandle
  session: SessionHandle
  state: ViewState
}
/** No browser or native UI. Implements lifecycle semantics for shared conformance tests. */
export class MockBackend
  implements
    RendererConsoleBackend,
    BrowserBackend,
    ClipboardBackend,
    ApplicationLifecycleBackend,
    WindowCommandsBackend,
    StatusItemBackend,
    ApplicationLinksBackend
{
  readonly descriptor: BackendDescriptor = Object.freeze({
    name: 'mock',
    version: '0.5.5', // x-release-please-version
    contractVersion: CONTRACT_VERSION,
    capabilityVersion: PROFILE_CAPABILITY_VERSION,
    capabilities: Object.freeze([
      'window.lifecycle',
      'view.navigate',
      'session.ephemeral',
    ] as const),
  })
  readonly #registry = new Registry()
  readonly #listeners = new Set<(event: RuntimeEvent) => void>()
  #disposed = false
  #listenerErrors = 0
  #desktopUnavailable(
    capability: 'clipboard.text' | 'app.lifecycle' | 'window.commands' | 'status.item',
    options?: OperationOptions
  ): never {
    this.#active()
    options?.signal?.throwIfAborted()
    requireCapability(this.descriptor, capability)
    throw new Error('Unreachable')
  }
  async readClipboardText(_scope: PolicyScope, options?: OperationOptions): Promise<string | null> {
    return this.#desktopUnavailable('clipboard.text', options)
  }
  async createApplicationLinkReader(
    _scope: PolicyScope,
    _options?: OperationOptions
  ): Promise<ApplicationLinkReader> {
    throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Mock application links are unavailable')
  }
  async readApplicationLinks(_reader: ApplicationLinkReader): Promise<ApplicationLinkBatch> {
    throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Mock application links are unavailable')
  }
  async acknowledgeApplicationLinks(
    _reader: ApplicationLinkReader,
    _batch: ApplicationLinkBatch
  ): Promise<void> {
    throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Mock application links are unavailable')
  }
  async disposeApplicationLinkReader(_reader: ApplicationLinkReader): Promise<void> {
    throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Mock application links are unavailable')
  }
  async openExternalUrl(_scope: PolicyScope, _url: string): Promise<void> {
    throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Mock external URLs are unavailable')
  }
  async createStatusItem(
    _scope: PolicyScope,
    _definition: StatusItemDefinition,
    options?: OperationOptions
  ): Promise<StatusItemHandle> {
    return this.#desktopUnavailable('status.item', options)
  }
  async updateStatusItem(
    _item: StatusItemHandle,
    _definition: StatusItemDefinition
  ): Promise<void> {
    this.#desktopUnavailable('status.item')
  }
  onStatusItemEvent(
    _item: StatusItemHandle,
    _listener: (event: StatusItemEvent) => void,
    options?: OperationOptions
  ): () => void {
    return this.#desktopUnavailable('status.item', options)
  }
  async disposeStatusItem(_item: StatusItemHandle): Promise<void> {
    this.#desktopUnavailable('status.item')
  }
  async writeClipboardText(
    _scope: PolicyScope,
    _text: string,
    options?: OperationOptions
  ): Promise<void> {
    this.#desktopUnavailable('clipboard.text', options)
  }
  async clearClipboard(_scope: PolicyScope, options?: OperationOptions): Promise<void> {
    this.#desktopUnavailable('clipboard.text', options)
  }
  async createWindowCommands(
    _scope: PolicyScope,
    _definition: WindowCommandsDefinition,
    options?: OperationOptions
  ): Promise<WindowCommandsHandle> {
    return this.#desktopUnavailable('window.commands', options)
  }
  async showWindowMenu(
    _commands: WindowCommandsHandle,
    _point: WindowMenuPoint,
    options?: OperationOptions
  ): Promise<void> {
    this.#desktopUnavailable('window.commands', options)
  }
  async cancelWindowMenu(_commands: WindowCommandsHandle): Promise<void> {
    this.#desktopUnavailable('window.commands')
  }
  onWindowCommandsEvent(
    _commands: WindowCommandsHandle,
    _listener: (event: WindowCommandsEvent) => void,
    options?: OperationOptions
  ): () => void {
    return this.#desktopUnavailable('window.commands', options)
  }
  async disposeWindowCommands(_commands: WindowCommandsHandle): Promise<void> {
    this.#desktopUnavailable('window.commands')
  }
  async whenApplicationReady(options?: OperationOptions): Promise<ApplicationState> {
    return this.#desktopUnavailable('app.lifecycle', options)
  }
  applicationState(): ApplicationState {
    return this.#desktopUnavailable('app.lifecycle')
  }
  onApplicationEvent(
    _listener: (event: ApplicationEvent) => void,
    options?: OperationOptions
  ): () => void {
    return this.#desktopUnavailable('app.lifecycle', options)
  }
  async quit(): Promise<void> {
    this.#desktopUnavailable('app.lifecycle')
  }
  async createSession(options: SessionOptions): Promise<SessionHandle> {
    this.#active()
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.partition) ||
      !['ephemeral', 'persistent'].includes(options.persistence)
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid session options')
    requireCapability(
      this.descriptor,
      options.persistence === 'persistent' ? 'session.persistent' : 'session.ephemeral'
    )
    if (
      (options.persistence === 'ephemeral' && options.persistentRoot !== undefined) ||
      (options.persistence === 'persistent' &&
        (typeof options.persistentRoot !== 'string' || options.persistentRoot.length === 0))
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid session options')
    if (options.network !== undefined) requireCapability(this.descriptor, 'session.network-policy')
    if (options.persistentCookies !== undefined)
      requireCapability(this.descriptor, 'session.protected-cookies')
    for (const h of this.#registry.handles('session')) {
      if (
        this.#registry.get<'session', SessionOptions>(h, 'session').partition === options.partition
      )
        throw new BunlyError('INVALID_ARGUMENT', 'Partition already has an owner')
    }
    const handle = this.#registry.create('session', Object.freeze({ ...options }))
    this.#emit({ type: 'created', resource: handle })
    return handle
  }
  async createWindow(options: WindowOptions): Promise<WindowHandle> {
    this.#active()
    validateBounds(options.bounds)
    if (options.viewLayout !== undefined && options.viewLayout !== 'stack') {
      if (options.viewLayout !== 'manual')
        throw new BunlyError('INVALID_ARGUMENT', 'Invalid view layout mode')
      requireCapability(this.descriptor, 'view.composition')
    }
    if (typeof options.title !== 'string' || options.title.length > 1024)
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid title')
    const handle = this.#registry.create(
      'window',
      Object.freeze({ ...options, bounds: Object.freeze({ ...options.bounds }) })
    )
    this.#emit({ type: 'created', resource: handle })
    return handle
  }
  async createView(options: ViewOptions): Promise<ViewHandle> {
    this.#active()
    if (options.presentation !== undefined || options.layer !== undefined)
      requireCapability(this.descriptor, 'view.composition')
    this.#registry.get(options.window, 'window')
    this.#registry.get(options.session, 'session')
    const url = normalizeUrl(options.url)
    if (options.trust.kind !== 'application' && options.trust.kind !== 'remote')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid trust policy')
    if (
      options.trust.kind === 'application' &&
      (originOf(options.trust.origin) !== options.trust.origin ||
        originOf(url) !== options.trust.origin ||
        options.trust.origin === 'null')
    )
      throw new BunlyError(
        'PERMISSION_DENIED',
        'Application origin must explicitly match the initial document'
      )
    const record: ViewRecord = {
      window: options.window,
      session: options.session,
      state: this.#state(url, options.trust),
    }
    const handle = this.#registry.create('view', record)
    this.#emit({ type: 'created', resource: handle })
    return handle
  }
  async navigate(view: ViewHandle, value: string, options?: OperationOptions): Promise<ViewState> {
    this.#active()
    options?.signal?.throwIfAborted()
    const record = this.#registry.get<'view', ViewRecord>(view, 'view')
    const url = normalizeUrl(value)
    const trust: ViewTrust =
      record.state.trust.kind === 'application' && originOf(url) === record.state.trust.origin
        ? record.state.trust
        : { kind: 'remote' }
    // Navigating back never implicitly restores a previously revoked application grant.
    record.state = this.#state(url, trust)
    this.#emit({ type: 'navigated', resource: view, state: record.state })
    return record.state
  }
  state(view: ViewHandle): ViewState {
    this.#active()
    return this.#registry.get<'view', ViewRecord>(view, 'view').state
  }
  session(view: ViewHandle): SessionHandle {
    this.#active()
    return this.#registry.get<'view', ViewRecord>(view, 'view').session
  }
  #windowUnavailable(
    window: WindowHandle,
    capability: 'window.state' | 'window.geometry',
    options?: OperationOptions
  ): never {
    this.#active()
    this.#registry.get(window, 'window')
    options?.signal?.throwIfAborted()
    requireCapability(this.descriptor, capability)
    throw new Error('Unreachable')
  }
  async windowState(window: WindowHandle, options?: OperationOptions): Promise<WindowState> {
    return this.#windowUnavailable(window, 'window.state', options)
  }
  async minimizeWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState> {
    return this.#windowUnavailable(window, 'window.state', options)
  }
  async restoreWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState> {
    return this.#windowUnavailable(window, 'window.state', options)
  }
  async activateWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState> {
    return this.#windowUnavailable(window, 'window.state', options)
  }
  async maximizeWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState> {
    return this.#windowUnavailable(window, 'window.state', options)
  }
  async setWindowFullscreen(
    window: WindowHandle,
    _fullscreen: boolean,
    options?: OperationOptions
  ): Promise<WindowState> {
    return this.#windowUnavailable(window, 'window.state', options)
  }
  async showWindow(
    window: WindowHandle,
    _visible: boolean,
    options?: OperationOptions
  ): Promise<void> {
    this.#windowUnavailable(window, 'window.state', options)
  }
  async resizeWindow(
    window: WindowHandle,
    _width: number,
    _height: number,
    options?: OperationOptions
  ): Promise<void> {
    this.#windowUnavailable(window, 'window.geometry', options)
  }
  async windowBounds(window: WindowHandle, options?: OperationOptions): Promise<Bounds> {
    return this.#windowUnavailable(window, 'window.geometry', options)
  }
  async setWindowBounds(
    window: WindowHandle,
    _bounds: Bounds,
    options?: OperationOptions
  ): Promise<Bounds> {
    return this.#windowUnavailable(window, 'window.geometry', options)
  }
  onViewConsole(
    view: ViewHandle,
    _listener: (message: string) => void,
    options?: OperationOptions
  ): () => void {
    this.#registry.get(view, 'view')
    options?.signal?.throwIfAborted()
    requireCapability(this.descriptor, 'view.console')
    throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Console observation unavailable')
  }
  onWindowEvent(
    window: WindowHandle,
    _listener: (event: WindowEvent) => void,
    options?: OperationOptions
  ): () => void {
    return this.#windowUnavailable(window, 'window.state', options)
  }
  async disposeView(view: ViewHandle): Promise<void> {
    if (this.#registry.dispose(view, 'view')) this.#emit({ type: 'disposed', resource: view })
  }
  async closeWindow(window: WindowHandle): Promise<void> {
    // Revoke ownership before child-disposal callbacks can attempt reentrant creation.
    // This also validates identity before any dependent resource is mutated.
    if (!this.#registry.dispose(window, 'window')) return
    for (const view of this.#registry.handles('view')) {
      if (this.#registry.isDisposed(view, 'view')) continue
      if (this.#registry.get<'view', ViewRecord>(view, 'view').window === window)
        await this.disposeView(view)
    }
    this.#emit({ type: 'disposed', resource: window })
  }
  async disposeSession(session: SessionHandle): Promise<void> {
    for (const view of this.#registry.handles('view')) {
      if (this.#registry.get<'view', ViewRecord>(view, 'view').session === session)
        throw new BunlyError('RESOURCE_IN_USE', 'Dispose session views first')
    }
    if (this.#registry.dispose(session, 'session'))
      this.#emit({ type: 'disposed', resource: session })
  }
  async snapshot(view: ViewHandle, options?: OperationOptions): Promise<Uint8Array> {
    this.state(view)
    options?.signal?.throwIfAborted()
    requireCapability(this.descriptor, 'view.snapshot')
    throw new Error('Unreachable')
  }
  async evaluate(view: ViewHandle, _script: string, options?: OperationOptions): Promise<unknown> {
    this.state(view)
    options?.signal?.throwIfAborted()
    requireCapability(this.descriptor, 'view.evaluate')
    throw new Error('Unreachable')
  }
  async input(view: ViewHandle, _action: InputAction, options?: OperationOptions): Promise<void> {
    this.state(view)
    options?.signal?.throwIfAborted()
    requireCapability(this.descriptor, 'view.input')
  }
  async cookies(session: SessionHandle, _query?: CookieQuery): Promise<readonly Cookie[]> {
    this.#active()
    this.#registry.get(session, 'session')
    requireCapability(this.descriptor, 'session.cookies')
    throw new Error('Unreachable')
  }
  async setCookie(session: SessionHandle, _url: string, _cookie: CookieInput): Promise<void> {
    this.#active()
    this.#registry.get(session, 'session')
    requireCapability(this.descriptor, 'session.cookies')
  }
  async deleteCookies(session: SessionHandle, _filter?: CookieDelete): Promise<number> {
    this.#active()
    this.#registry.get(session, 'session')
    requireCapability(this.descriptor, 'session.cookies')
    throw new Error('Unreachable')
  }
  async clearSession(
    session: SessionHandle,
    options: SessionClearOptions
  ): Promise<SessionClearResult> {
    this.#active()
    this.#registry.get(session, 'session')
    if (options.cookies) requireCapability(this.descriptor, 'session.cookies')
    if (options.cache) requireCapability(this.descriptor, 'session.cache')
    if (options.storage) requireCapability(this.descriptor, 'session.storage-clear')
    throw new Error('Unreachable')
  }
  async flushSession(session: SessionHandle): Promise<void> {
    this.#active()
    this.#registry.get(session, 'session')
    requireCapability(this.descriptor, 'session.flush')
  }
  async requestPermission(view: ViewHandle, _permission: string): Promise<'granted' | 'denied'> {
    this.state(view)
    requireCapability(this.descriptor, 'permission.request')
    throw new Error('Unreachable')
  }
  async download(
    view: ViewHandle,
    _request: DownloadRequest,
    options?: OperationOptions
  ): Promise<DownloadResult> {
    this.state(view)
    options?.signal?.throwIfAborted()
    requireCapability(this.descriptor, 'download.manage')
    throw new Error('Unreachable')
  }
  async extension(
    view: ViewHandle,
    _name: `${string}:${string}`,
    _input: unknown
  ): Promise<unknown> {
    this.state(view)
    requireCapability(this.descriptor, 'backend.extensions')
    throw new Error('Unreachable')
  }
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#active()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  diagnostics(): Diagnostics {
    return Object.freeze({
      windows: this.#registry.count('window'),
      views: this.#registry.count('view'),
      sessions: this.#registry.count('session'),
      listeners: this.#listeners.size,
      listenerErrors: this.#listenerErrors,
    })
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const window of this.#registry.handles('window')) await this.closeWindow(window)
    for (const session of this.#registry.handles('session')) await this.disposeSession(session)
    this.#listeners.clear()
  }
  #active(): void {
    if (this.#disposed) throw new BunlyError('DISPOSED', 'Backend disposed')
  }
  #state(url: string, trust: ViewTrust): ViewState {
    return Object.freeze({
      url,
      documentId: crypto.randomUUID(),
      trust: Object.freeze({ ...trust }),
    })
  }
  #emit(event: RuntimeEvent): void {
    const frozen = Object.freeze(event)
    // Snapshot: subscriptions added during delivery begin with the next event.
    const listeners = Array.from(this.#listeners)
    for (const listener of listeners) {
      if (!this.#listeners.has(listener)) continue
      try {
        listener(frozen)
      } catch {
        this.#listenerErrors++
      }
    }
  }
}

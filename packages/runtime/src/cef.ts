import { randomUUID } from 'node:crypto'
import { NativeTransport, type NativeEvent } from './native-transport.ts'
import { Registry } from './registry.ts'
import {
  CONTRACT_VERSION,
  PROFILE_CAPABILITY_VERSION,
  BunlyError,
  normalizeUrl,
  originOf,
  validateBounds,
} from '../../contracts/src/index.ts'
import type {
  BrowserBackend,
  BackendDescriptor,
  Diagnostics,
  WindowHandle,
  ViewHandle,
  SessionHandle,
  WindowOptions,
  ViewOptions,
  SessionOptions,
  ViewState,
  ViewTrust,
  RuntimeEvent,
  OperationOptions,
  InputAction,
  Cookie,
  DownloadRequest,
  DownloadResult,
  Handle,
  ResourceKind,
} from '../../contracts/src/index.ts'
interface NativeResource {
  native: number
}
interface SessionResource extends NativeResource {
  partition: string
}
interface ViewResource extends NativeResource {
  window: WindowHandle
  session: SessionHandle
  state: ViewState
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native result')
  return value as Record<string, unknown>
}
function nativeId(value: unknown): number {
  const id = record(value)['id']
  if (!Number.isSafeInteger(id) || Number(id) < 1)
    throw new Error('Invalid native resource identity')
  return Number(id)
}
function unsupported(capability: string): never {
  throw new BunlyError('UNSUPPORTED_CAPABILITY', `cef does not yet implement ${capability}`)
}
/** Native-owned windows and sessions. This module is never imported by renderer code. */
export class CefBackend implements BrowserBackend {
  readonly descriptor: BackendDescriptor = Object.freeze({
    name: 'cef',
    version: '0.1.0-dev.0',
    contractVersion: CONTRACT_VERSION,
    capabilityVersion: PROFILE_CAPABILITY_VERSION,
    capabilities: Object.freeze([
      'window.lifecycle',
      'view.navigate',
      'session.ephemeral',
    ] as const),
  })
  readonly #transport: NativeTransport
  readonly #registry = new Registry()
  // Native IDs are lookup keys only; public operations still validate opaque registry handles.
  readonly #native = new Map<number, Handle<ResourceKind>>()
  readonly #windowViews = new WeakMap<WindowHandle, Set<ViewHandle>>()
  readonly #sessionViews = new WeakMap<SessionHandle, Set<ViewHandle>>()
  readonly #listeners = new Set<(event: RuntimeEvent) => void>()
  readonly #observers = new Set<(event: NativeEvent) => void>()
  readonly #closing = new WeakMap<Handle<ResourceKind>, Promise<void>>()
  readonly #partitions = new Set<string>()
  #shutdown: Promise<void> | undefined
  #disposed = false
  #listenerErrors = 0
  readonly closed: Promise<void>
  constructor(transport: NativeTransport) {
    this.#transport = transport
    transport.onEvent((event) => {
      try {
        this.#event(event)
      } catch (error) {
        transport.fail(error)
      }
    })
    this.closed = transport.closed.then(() => {
      this.#disposed = true
      for (const kind of ['view', 'window', 'session'] as const)
        for (const handle of this.#registry.handles(kind)) {
          this.#windowViews.delete(handle as WindowHandle)
          this.#sessionViews.delete(handle as SessionHandle)
          this.#registry.dispose(handle, kind)
        }
      this.#native.clear()
      this.#listeners.clear()
      this.#observers.clear()
      this.#partitions.clear()
      if (transport.failure) throw transport.failure
    })
    void this.closed.catch(() => {})
  }
  #active(): void {
    if (this.#disposed) throw new BunlyError('DISPOSED', 'CEF backend disposed')
  }
  #createdId(value: unknown): number {
    try {
      return nativeId(value)
    } catch (error) {
      // An unaddressable creation cannot be safely left running in the native host.
      this.#transport.fail(error)
      throw error
    }
  }
  #remember<K extends ResourceKind, T extends NativeResource>(kind: K, value: T): Handle<K> {
    if (this.#native.has(value.native)) {
      const error = new Error('Duplicate live native resource identity')
      this.#transport.fail(error)
      throw error
    }
    const handle = this.#registry.create(kind, value)
    this.#native.set(value.native, handle)
    return handle
  }
  #emit(event: RuntimeEvent): void {
    if (event.type === 'navigated') {
      Object.freeze(event.state.trust)
      Object.freeze(event.state)
    }
    Object.freeze(event)
    for (const listener of Array.from(this.#listeners)) {
      if (!this.#listeners.has(listener)) continue
      try {
        listener(event)
      } catch {
        this.#listenerErrors++
      }
    }
  }
  async createSession(options: SessionOptions): Promise<SessionHandle> {
    this.#active()
    const { partition, persistence } = options
    if (
      !['ephemeral', 'persistent'].includes(persistence) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(partition)
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid session options')
    if (persistence !== 'ephemeral') unsupported('session.persistent')
    if (this.#partitions.has(partition))
      throw new BunlyError('INVALID_ARGUMENT', 'Partition already has an owner')
    this.#partitions.add(partition)
    try {
      const native = this.#createdId(
        await this.#transport.call('session.create', {
          persistence,
          partition,
        })
      )
      this.#active()
      const handle = this.#remember('session', { native, partition })
      this.#sessionViews.set(handle, new Set())
      this.#emit({ type: 'created', resource: handle })
      return handle
    } catch (error) {
      this.#partitions.delete(partition)
      throw error
    }
  }
  async createWindow(options: WindowOptions): Promise<WindowHandle> {
    this.#active()
    validateBounds(options.bounds)
    if (
      typeof options.title !== 'string' ||
      options.title.length > 1024 ||
      options.title.includes('\0')
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid window title')
    const native = this.#createdId(
      await this.#transport.call('window.create', { title: options.title, ...options.bounds })
    )
    this.#active()
    const handle = this.#remember('window', { native })
    this.#windowViews.set(handle, new Set())
    this.#emit({ type: 'created', resource: handle })
    return handle
  }
  async createView(options: ViewOptions): Promise<ViewHandle> {
    this.#active()
    const { window: windowHandle, session: sessionHandle } = options
    const window = this.#registry.get<'window', NativeResource>(windowHandle, 'window')
    const session = this.#registry.get<'session', NativeResource>(sessionHandle, 'session')
    if (this.#closing.has(windowHandle) || this.#closing.has(sessionHandle))
      throw new BunlyError('DISPOSED', 'Window is closing')
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
    const trust: ViewTrust = Object.freeze({ ...options.trust })
    const native = this.#createdId(
      await this.#transport.call('view.create', {
        window: window.native,
        session: session.native,
        url,
      })
    )
    try {
      this.#active()
      this.#registry.get(windowHandle, 'window')
      this.#registry.get(sessionHandle, 'session')
      if (this.#closing.has(windowHandle) || this.#closing.has(sessionHandle))
        throw new BunlyError('DISPOSED', 'View owner is closing')
    } catch (error) {
      if (!this.#disposed)
        await this.#transport.call('view.dispose', { id: native }).catch(() => {})
      throw error
    }
    const handle = this.#remember('view', {
      native,
      window: windowHandle,
      session: sessionHandle,
      state: { url, documentId: randomUUID(), trust },
    } satisfies ViewResource)
    this.#windowViews.get(windowHandle)!.add(handle)
    this.#sessionViews.get(sessionHandle)!.add(handle)
    this.#emit({ type: 'created', resource: handle })
    return handle
  }
  async navigate(
    view: ViewHandle,
    value: string,
    options: OperationOptions = {}
  ): Promise<ViewState> {
    this.#active()
    const resource = this.#registry.get<'view', ViewResource>(view, 'view')
    if (this.#closing.has(view) || this.#closing.has(resource.window))
      throw new BunlyError('DISPOSED', 'View is closing')
    const url = normalizeUrl(value)
    await this.#transport.call('view.navigate', { id: resource.native, url }, options.signal)
    this.#active()
    this.#registry.get(view, 'view')
    return structuredClone(resource.state)
  }
  state(view: ViewHandle): ViewState {
    this.#active()
    return structuredClone(this.#registry.get<'view', ViewResource>(view, 'view').state)
  }
  session(view: ViewHandle): SessionHandle {
    this.#active()
    return this.#registry.get<'view', ViewResource>(view, 'view').session
  }
  async showWindow(window: WindowHandle, visible: boolean): Promise<void> {
    this.#active()
    if (typeof visible !== 'boolean') throw new BunlyError('INVALID_ARGUMENT', 'Invalid visibility')
    if (this.#closing.has(window)) throw new BunlyError('DISPOSED', 'Window is closing')
    const { native } = this.#registry.get<'window', NativeResource>(window, 'window')
    await this.#transport.call(visible ? 'window.show' : 'window.hide', { id: native })
  }
  async resizeWindow(window: WindowHandle, width: number, height: number): Promise<void> {
    this.#active()
    if (this.#closing.has(window)) throw new BunlyError('DISPOSED', 'Window is closing')
    validateBounds({ x: 0, y: 0, width, height })
    const { native } = this.#registry.get<'window', NativeResource>(window, 'window')
    await this.#transport.call('window.resize', { id: native, width, height })
  }
  async focusView(view: ViewHandle): Promise<void> {
    this.#active()
    const resource = this.#registry.get<'view', ViewResource>(view, 'view')
    if (this.#closing.has(view) || this.#closing.has(resource.window))
      throw new BunlyError('DISPOSED', 'View is closing')
    await this.#transport.call('view.focus', { id: resource.native })
  }
  #disposeResource<K extends ResourceKind>(
    handle: Handle<K>,
    kind: K,
    operation: string,
    after: () => void
  ): Promise<void> {
    const existing = this.#closing.get(handle)
    if (existing) return existing
    if (this.#registry.isDisposed(handle, kind)) return Promise.resolve()
    if (this.#disposed) return this.closed
    const { native } = this.#registry.get<K, NativeResource>(handle, kind)
    // Reserve ownership before native calls or disposal events can reenter.
    const promise = Promise.resolve()
      .then(() => this.#transport.call(operation, { id: native }))
      .then(after)
      .catch((error) => {
        if (this.#registry.isDisposed(handle, kind)) return
        this.#closing.delete(handle)
        throw error
      })
    this.#closing.set(handle, promise)
    return promise
  }
  async closeWindow(window: WindowHandle): Promise<void> {
    return this.#disposeResource(window, 'window', 'window.close', () => this.#dropWindow(window))
  }
  #dropWindow(window: WindowHandle): void {
    if (this.#registry.isDisposed(window, 'window')) return
    const { native } = this.#registry.get<'window', NativeResource>(window, 'window')
    const children = this.#windowViews.get(window)
    // Revoke parent identity before callbacks, and avoid scanning unrelated windows/views.
    this.#registry.dispose(window, 'window')
    this.#native.delete(native)
    this.#windowViews.delete(window)
    if (children) for (const view of children) this.#dropView(view)
    this.#emit({ type: 'disposed', resource: window })
  }
  #dropView(view: ViewHandle): void {
    if (this.#registry.isDisposed(view, 'view')) return
    const { native, window, session } = this.#registry.get<'view', ViewResource>(view, 'view')
    this.#registry.dispose(view, 'view')
    this.#native.delete(native)
    this.#windowViews.get(window)?.delete(view)
    this.#sessionViews.get(session)?.delete(view)
    this.#emit({ type: 'disposed', resource: view })
  }
  async disposeView(view: ViewHandle): Promise<void> {
    return this.#disposeResource(view, 'view', 'view.dispose', () => this.#dropView(view))
  }
  async disposeSession(session: SessionHandle): Promise<void> {
    if (this.#registry.isDisposed(session, 'session')) return
    const { partition, native } = this.#registry.get<'session', SessionResource>(session, 'session')
    if (this.#sessionViews.get(session)?.size)
      throw new BunlyError('RESOURCE_IN_USE', 'Session has live views')
    return this.#disposeResource(session, 'session', 'session.dispose', () => {
      if (this.#registry.dispose(session, 'session')) {
        this.#partitions.delete(partition)
        this.#native.delete(native)
        this.#sessionViews.delete(session)
        this.#emit({ type: 'disposed', resource: session })
      }
    })
  }
  async snapshot(_view: ViewHandle, _options?: OperationOptions): Promise<Uint8Array> {
    return unsupported('view.snapshot')
  }
  async evaluate(
    _view: ViewHandle,
    _script: string,
    _options?: OperationOptions
  ): Promise<unknown> {
    return unsupported('view.evaluate')
  }
  async input(_view: ViewHandle, _action: InputAction, _options?: OperationOptions): Promise<void> {
    return unsupported('view.input')
  }
  async cookies(_session: SessionHandle): Promise<readonly Cookie[]> {
    return unsupported('session.cookies')
  }
  async requestPermission(view: ViewHandle, _permission: string): Promise<'granted' | 'denied'> {
    this.state(view)
    return unsupported('permission.request')
  }
  async download(
    _view: ViewHandle,
    _request: DownloadRequest,
    _options?: OperationOptions
  ): Promise<DownloadResult> {
    return unsupported('download.manage')
  }
  async extension(
    _view: ViewHandle,
    _name: `${string}:${string}`,
    _input: unknown
  ): Promise<unknown> {
    return unsupported('backend.extensions')
  }
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#active()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  observe(listener: (event: NativeEvent) => void): () => void {
    this.#active()
    this.#observers.add(listener)
    return () => {
      this.#observers.delete(listener)
    }
  }
  diagnostics(): Diagnostics {
    return {
      windows: this.#registry.count('window'),
      views: this.#registry.count('view'),
      sessions: this.#registry.count('session'),
      listeners: this.#listeners.size + this.#observers.size,
      listenerErrors: this.#listenerErrors,
    }
  }
  async nativeDiagnostics(): Promise<unknown> {
    return this.#transport.call('diagnostics')
  }
  dispose(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    if (this.#disposed) return this.closed
    this.#disposed = true
    this.#shutdown = this.#transport
      .call('quit')
      .then(() => this.closed)
      .catch((error) => {
        this.#transport.fail(error)
        throw error
      })
    return this.#shutdown
  }
  #event(event: NativeEvent): void {
    const handle = event.target === undefined ? undefined : this.#native.get(event.target)
    const window = handle?.kind === 'window' ? (handle as WindowHandle) : undefined
    const view = handle?.kind === 'view' ? (handle as ViewHandle) : undefined
    if (event.event === 'window.closed' && window) this.#dropWindow(window)
    else if (event.event === 'view.closed' && view) this.#dropView(view)
    else if (view && (event.event === 'view.navigating' || event.event === 'view.loaded')) {
      if (typeof event.data?.['url'] !== 'string') throw new Error('Missing native navigation URL')
      const resource = this.#registry.get<'view', ViewResource>(view, 'view')
      const url = normalizeUrl(event.data['url'])
      const trust =
        resource.state.trust.kind === 'application' && resource.state.trust.origin === originOf(url)
          ? resource.state.trust
          : ({ kind: 'remote' } as const)
      resource.state = { url, documentId: randomUUID(), trust }
      this.#emit({ type: 'navigated', resource: view, state: structuredClone(resource.state) })
    }
    for (const observer of Array.from(this.#observers)) {
      if (!this.#observers.has(observer)) continue
      try {
        observer(event)
      } catch {
        this.#listenerErrors++
      }
    }
  }
}
export async function connectCefBackend(): Promise<CefBackend> {
  if (process.env['BUNLY_NATIVE_STDIO'] !== '1')
    throw new Error('Launch with the packaged Bunly native host')
  const transport = new NativeTransport(process.stdin, process.stdout)
  const timeout = setTimeout(
    () => transport.fail(new Error('Native initialization deadline')),
    10000
  )
  try {
    await transport.ready
    await transport.call('hello', { bun: Bun.version })
    return new CefBackend(transport)
  } finally {
    clearTimeout(timeout)
  }
}

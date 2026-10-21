import { randomUUID } from 'node:crypto'
import { NativeTransport, type NativeEvent } from './native-transport.ts'
import { Registry } from './registry.ts'
import {
  CONTRACT_VERSION,
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
    capabilities: Object.freeze([
      'window.lifecycle',
      'view.navigate',
      'session.ephemeral',
    ] as const),
  })
  readonly #transport: NativeTransport
  readonly #registry = new Registry()
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
    transport.onEvent((event) => this.#event(event))
    this.closed = transport.closed.then(() => {
      this.#disposed = true
      for (const kind of ['view', 'window', 'session'] as const)
        for (const handle of this.#registry.handles(kind)) this.#registry.dispose(handle, kind)
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
  #emit(event: RuntimeEvent): void {
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
    if (
      !['ephemeral', 'persistent'].includes(options.persistence) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.partition)
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid session options')
    if (options.persistence !== 'ephemeral') unsupported('session.persistent')
    if (this.#partitions.has(options.partition))
      throw new BunlyError('INVALID_ARGUMENT', 'Partition already has an owner')
    this.#partitions.add(options.partition)
    try {
      const native = nativeId(
        await this.#transport.call('session.create', {
          persistence: options.persistence,
          partition: options.partition,
        })
      )
      this.#active()
      const handle = this.#registry.create('session', { native, partition: options.partition })
      this.#emit({ type: 'created', resource: handle })
      return handle
    } catch (error) {
      this.#partitions.delete(options.partition)
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
    const native = nativeId(
      await this.#transport.call('window.create', { title: options.title, ...options.bounds })
    )
    this.#active()
    const handle = this.#registry.create('window', { native })
    this.#emit({ type: 'created', resource: handle })
    return handle
  }
  async createView(options: ViewOptions): Promise<ViewHandle> {
    this.#active()
    const window = this.#registry.get<'window', NativeResource>(options.window, 'window')
    const session = this.#registry.get<'session', NativeResource>(options.session, 'session')
    if (this.#closing.has(options.window) || this.#closing.has(options.session))
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
    const native = nativeId(
      await this.#transport.call('view.create', {
        window: window.native,
        session: session.native,
        url,
      })
    )
    try {
      this.#active()
      this.#registry.get(options.window, 'window')
      this.#registry.get(options.session, 'session')
      if (this.#closing.has(options.window) || this.#closing.has(options.session))
        throw new BunlyError('DISPOSED', 'View owner is closing')
    } catch (error) {
      if (!this.#disposed)
        await this.#transport.call('view.dispose', { id: native }).catch(() => {})
      throw error
    }
    const handle = this.#registry.create('view', {
      native,
      window: options.window,
      session: options.session,
      state: { url, documentId: randomUUID(), trust },
    } satisfies ViewResource)
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
  async showWindow(window: WindowHandle, visible: boolean): Promise<void> {
    this.#active()
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
    // Revoke parent identity first; child-disposal listeners may reenter createView.
    if (!this.#registry.dispose(window, 'window')) return
    for (const view of this.#registry.handles('view'))
      if (this.#registry.get<'view', ViewResource>(view, 'view').window === window)
        this.#dropView(view)
    this.#emit({ type: 'disposed', resource: window })
  }
  #dropView(view: ViewHandle): void {
    if (this.#registry.dispose(view, 'view')) this.#emit({ type: 'disposed', resource: view })
  }
  async disposeView(view: ViewHandle): Promise<void> {
    return this.#disposeResource(view, 'view', 'view.dispose', () => this.#dropView(view))
  }
  async disposeSession(session: SessionHandle): Promise<void> {
    if (this.#registry.isDisposed(session, 'session')) return
    const { partition } = this.#registry.get<'session', SessionResource>(session, 'session')
    for (const view of this.#registry.handles('view'))
      if (this.#registry.get<'view', ViewResource>(view, 'view').session === session)
        throw new BunlyError('RESOURCE_IN_USE', 'Session has live views')
    return this.#disposeResource(session, 'session', 'session.dispose', () => {
      if (this.#registry.dispose(session, 'session')) {
        this.#partitions.delete(partition)
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
      windows: this.#registry.handles('window').length,
      views: this.#registry.handles('view').length,
      sessions: this.#registry.handles('session').length,
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
    const window = this.#registry
      .handles('window')
      .find(
        (handle) =>
          this.#registry.get<'window', NativeResource>(handle, 'window').native === event.target
      )
    const view = this.#registry
      .handles('view')
      .find(
        (handle) => this.#registry.get<'view', ViewResource>(handle, 'view').native === event.target
      )
    if (event.event === 'window.closed' && window) this.#dropWindow(window)
    else if (event.event === 'view.closed' && view) this.#dropView(view)
    else if (
      view &&
      (event.event === 'view.navigating' || event.event === 'view.loaded') &&
      typeof event.data?.['url'] === 'string'
    ) {
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

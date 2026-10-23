import { isAbsolute } from 'node:path'
import { NativeTransport, type NativeEvent } from './native-transport.ts'
import { Registry } from './registry.ts'
import { RpcServer } from './rpc.ts'
import { RpcViewAuthority } from './rpc-authority.ts'
import { RpcError } from '../../contracts/src/rpc.ts'
import type { RpcSchema, RpcTransport } from '../../contracts/src/rpc.ts'
import type { RpcHandlers, RpcServerOptions } from './rpc.ts'
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
  SessionClearOptions,
  SessionClearResult,
  WindowOptions,
  ViewOptions,
  SessionOptions,
  ViewState,
  ViewTrust,
  RuntimeEvent,
  OperationOptions,
  InputAction,
  Cookie,
  CookieDelete,
  CookieInput,
  CookieQuery,
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
  persistence: SessionOptions['persistence']
}
interface ViewResource extends NativeResource {
  window: WindowHandle
  session: SessionHandle
  state: ViewState
}
const MAX_NATIVE_RPC_PACKET = 24 * 1024
function hex(packet: Uint8Array): string {
  if (
    !(packet instanceof Uint8Array) ||
    packet.byteLength < 1 ||
    packet.byteLength > MAX_NATIVE_RPC_PACKET
  )
    throw new RpcError('PROTOCOL_ERROR', 'Native RPC packet size denied')
  let result = ''
  for (const byte of packet) result += byte.toString(16).padStart(2, '0')
  return result
}
function unhex(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length % 2 ||
    value.length > MAX_NATIVE_RPC_PACKET * 2 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw new RpcError('PROTOCOL_ERROR', 'Invalid native RPC packet encoding')
  const packet = new Uint8Array(value.length / 2)
  for (let index = 0; index < packet.length; index++)
    packet[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return packet
}
class CefRpcTransport implements RpcTransport {
  #message: ((packet: Uint8Array) => void) | undefined
  #closed: (() => void) | undefined
  #ended = false
  constructor(
    readonly native: NativeTransport,
    readonly identity: Readonly<{ connection: number; context: number; generation: number }>
  ) {}
  send(packet: Uint8Array): Promise<void> {
    if (this.#ended)
      return Promise.reject(new RpcError('DISCONNECTED', 'Native RPC transport closed'))
    return this.native.call('rpc.deliver', { ...this.identity, packet: hex(packet) }).then(() => {})
  }
  subscribe(message: (packet: Uint8Array) => void, closed: () => void): () => void {
    if (this.#message) throw new TypeError('Native RPC transport permits one subscriber')
    this.#message = message
    this.#closed = closed
    return () => {
      this.#message = undefined
      this.#closed = undefined
    }
  }
  receive(packet: Uint8Array, sequence: number): void {
    if (this.#ended || !this.#message) return
    this.#message(packet)
    if (this.#ended) return
    void this.native.call('rpc.ack', { ...this.identity, sequence }).catch(() => this.end(false))
  }
  close(): void {
    this.end(true)
  }
  end(tellNative: boolean): void {
    if (this.#ended) return
    this.#ended = true
    if (tellNative) void this.native.call('rpc.disconnect', { ...this.identity }).catch(() => {})
    this.#closed?.()
    this.#message = undefined
    this.#closed = undefined
  }
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
function nativeDocumentId(value: unknown): string {
  const documentId = record(value)['documentId']
  if (typeof documentId !== 'string' || !/^[a-z0-9-]{1,128}$/.test(documentId))
    throw new Error('Invalid native document identity')
  return documentId
}
function unsupported(capability: string): never {
  throw new BunlyError('UNSUPPORTED_CAPABILITY', `cef does not yet implement ${capability}`)
}
function cookieUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BunlyError('INVALID_ARGUMENT', 'Cookie URL must be absolute')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new BunlyError('INVALID_ARGUMENT', 'Cookie URL must be credential-free HTTP(S)')
  return url.href
}
function boundedText(value: unknown, name: string, maximum: number, empty = true): string {
  if (
    typeof value !== 'string' ||
    (!empty && value.length === 0) ||
    value.length > maximum ||
    value.includes('\0')
  )
    throw new BunlyError('INVALID_ARGUMENT', `Invalid cookie ${name}`)
  return value
}
function checkedCookie(value: CookieInput): CookieInput {
  if (!value || typeof value !== 'object')
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid cookie')
  const sameSite = value.sameSite ?? 'unspecified'
  if (!['unspecified', 'none', 'lax', 'strict'].includes(sameSite))
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid cookie sameSite')
  if (
    (value.secure !== undefined && typeof value.secure !== 'boolean') ||
    (value.httpOnly !== undefined && typeof value.httpOnly !== 'boolean')
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid cookie flags')
  if (
    value.expires !== undefined &&
    (!Number.isSafeInteger(value.expires) || value.expires <= Date.now())
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Cookie expiry must be a future Unix millisecond')
  return Object.freeze({
    name: boundedText(value.name, 'name', 256, false),
    value: boundedText(value.value, 'value', 4096),
    ...(value.domain === undefined
      ? {}
      : { domain: boundedText(value.domain, 'domain', 255, false) }),
    ...(value.path === undefined ? {} : { path: boundedText(value.path, 'path', 1024, false) }),
    secure: value.secure ?? false,
    httpOnly: value.httpOnly ?? false,
    sameSite,
    ...(value.expires === undefined ? {} : { expires: value.expires }),
  })
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
      'session.persistent',
      'session.cookies',
      'session.cache',
      'session.flush',
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
  // Native application grants are one-shot. Fence local lifecycle transitions
  // before their queued native acknowledgement/handshake can arrive.
  readonly #rpcRetired = new WeakSet<ViewHandle>()
  readonly #rpcConnections = new Map<
    number,
    { view: ViewHandle; transport: CefRpcTransport; server: RpcServer<RpcSchema> }
  >()
  #rpcService:
    | {
        authority: RpcViewAuthority
        schema: RpcSchema
        handlers: RpcHandlers<RpcSchema>
        capabilities: readonly string[]
        options: RpcServerOptions
      }
    | undefined
  #shutdown: Promise<void> | undefined
  #rpcConfigured = false
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
      this.#rpcService?.authority.dispose()
      this.#rpcService = undefined
      for (const connection of this.#rpcConnections.values()) connection.transport.end(false)
      this.#rpcConnections.clear()
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
    const persistentRoot = options.persistentRoot
    if (
      (persistence === 'ephemeral' && persistentRoot !== undefined) ||
      (persistence === 'persistent' &&
        (typeof persistentRoot !== 'string' ||
          persistentRoot.length === 0 ||
          persistentRoot.length > 4096 ||
          persistentRoot.includes('\0') ||
          !isAbsolute(persistentRoot)))
    )
      throw new BunlyError(
        'INVALID_ARGUMENT',
        'Persistent sessions require an explicit absolute persistentRoot; ephemeral sessions forbid it'
      )
    if (this.#partitions.has(partition))
      throw new BunlyError('INVALID_ARGUMENT', 'Partition already has an owner')
    this.#partitions.add(partition)
    try {
      const native = this.#createdId(
        await this.#transport.call('session.create', {
          persistence,
          partition,
          ...(persistentRoot === undefined ? {} : { persistentRoot }),
        })
      )
      this.#active()
      const handle = this.#remember('session', { native, partition, persistence })
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
    const created = await this.#transport.call('view.create', {
      window: window.native,
      session: session.native,
      url,
      trust,
    })
    const native = this.#createdId(created)
    let documentId: string
    try {
      documentId = nativeDocumentId(created)
    } catch (error) {
      // An unbound native document must never survive as an orphan authority.
      this.#transport.fail(error)
      throw error
    }
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
      state: { url, documentId, trust },
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
    this.#retireRpc(view)
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
    if (kind === 'view') this.#retireRpc(handle as ViewHandle)
    if (kind === 'window')
      for (const view of this.#windowViews.get(handle as WindowHandle) ?? []) this.#retireRpc(view)
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
  #session(session: SessionHandle): SessionResource {
    this.#active()
    if (this.#closing.has(session)) throw new BunlyError('DISPOSED', 'Session is disposing')
    return this.#registry.get<'session', SessionResource>(session, 'session')
  }
  async cookies(session: SessionHandle, query: CookieQuery = {}): Promise<readonly Cookie[]> {
    const resource = this.#session(session)
    const value = await this.#transport.call('session.cookies', {
      id: resource.native,
      ...(query.url === undefined ? {} : { url: cookieUrl(query.url) }),
    })
    if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid native cookie result')
    const result = value.map((entry): Cookie => {
      const item = record(entry)
      if (
        typeof item['secure'] !== 'boolean' ||
        typeof item['httpOnly'] !== 'boolean' ||
        !['unspecified', 'none', 'lax', 'strict'].includes(String(item['sameSite'])) ||
        (item['expires'] !== undefined && !Number.isSafeInteger(item['expires']))
      )
        throw new Error('Invalid native cookie result')
      return Object.freeze({
        name: boundedText(item['name'], 'name', 256, false),
        value: boundedText(item['value'], 'value', 4096),
        domain: boundedText(item['domain'], 'domain', 255),
        path: boundedText(item['path'], 'path', 1024),
        secure: item['secure'],
        httpOnly: item['httpOnly'],
        sameSite: item['sameSite'] as Cookie['sameSite'],
        ...(item['expires'] === undefined ? {} : { expires: Number(item['expires']) }),
      })
    })
    return Object.freeze(result)
  }
  async setCookie(session: SessionHandle, url: string, cookie: CookieInput): Promise<void> {
    const resource = this.#session(session)
    await this.#transport.call('session.cookie.set', {
      id: resource.native,
      url: cookieUrl(url),
      cookie: checkedCookie(cookie),
    })
  }
  async deleteCookies(session: SessionHandle, filter: CookieDelete = {}): Promise<number> {
    const resource = this.#session(session)
    const url = filter.url === undefined ? undefined : cookieUrl(filter.url)
    const name =
      filter.name === undefined ? undefined : boundedText(filter.name, 'name', 256, false)
    const value = await this.#transport.call('session.cookies.delete', {
      id: resource.native,
      ...(url === undefined ? {} : { url }),
      ...(name === undefined ? {} : { name }),
    })
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100_000)
      throw new Error('Invalid native cookie deletion result')
    return Number(value)
  }
  async clearSession(
    session: SessionHandle,
    options: SessionClearOptions
  ): Promise<SessionClearResult> {
    const resource = this.#session(session)
    if (!options || typeof options !== 'object')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid session clear options')
    const cookies = options.cookies ?? false
    const cache = options.cache ?? false
    const storage = options.storage ?? false
    if (
      ![cookies, cache, storage].every((value) => typeof value === 'boolean') ||
      (!cookies && !cache && !storage)
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Select at least one session data kind to clear')
    if (storage) unsupported('session.storage-clear')
    const value = record(
      await this.#transport.call('session.clear', { id: resource.native, cookies, cache })
    )
    if (
      !Number.isSafeInteger(value['cookiesDeleted']) ||
      Number(value['cookiesDeleted']) < 0 ||
      typeof value['cacheCleared'] !== 'boolean' ||
      value['storageCleared'] !== false
    )
      throw new Error('Invalid native session clear result')
    return Object.freeze({
      cookiesDeleted: Number(value['cookiesDeleted']),
      cacheCleared: value['cacheCleared'],
      storageCleared: false,
    })
  }
  async flushSession(session: SessionHandle): Promise<void> {
    const resource = this.#session(session)
    await this.#transport.call('session.flush', { id: resource.native })
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
  serveRpc<S extends RpcSchema>(
    schema: S,
    handlers: RpcHandlers<S>,
    origins: readonly string[],
    capabilities: readonly string[],
    options: RpcServerOptions = {}
  ): () => void {
    this.#active()
    if (this.#rpcConfigured)
      throw new BunlyError('INVALID_ARGUMENT', 'CEF host already has an RPC authority manager')
    const authority = new RpcViewAuthority(this, origins)
    this.#rpcConfigured = true
    this.#rpcService = {
      authority,
      schema,
      handlers: handlers as RpcHandlers<RpcSchema>,
      capabilities: Object.freeze([...capabilities]),
      options,
    }
    return () => {
      if (this.#rpcService?.authority !== authority) return
      authority.dispose()
      this.#rpcService = undefined
      for (const connection of this.#rpcConnections.values()) connection.transport.end(true)
      this.#rpcConnections.clear()
    }
  }
  dispose(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    if (this.#disposed) return this.closed
    this.#disposed = true
    this.#rpcService?.authority.dispose()
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
      const documentId = nativeDocumentId(event.data)
      const trust =
        (event.event === 'view.loaded' || event.data['applicationTrust'] === true) &&
        resource.state.trust.kind === 'application' &&
        resource.state.trust.origin === originOf(url)
          ? resource.state.trust
          : ({ kind: 'remote' } as const)
      const changed =
        resource.state.documentId !== documentId ||
        resource.state.url !== url ||
        resource.state.trust.kind !== trust.kind
      resource.state = { url, documentId, trust }
      if (changed)
        this.#emit({ type: 'navigated', resource: view, state: structuredClone(resource.state) })
    } else if (view && event.event === 'rpc.connected') this.#rpcConnected(view, event.data)
    else if (event.event === 'rpc.packet') this.#rpcPacket(view, event.data)
    else if (event.event === 'rpc.revoked') this.#rpcRevoked(view, event.data)
    for (const observer of Array.from(this.#observers)) {
      if (!this.#observers.has(observer)) continue
      try {
        observer(event)
      } catch {
        this.#listenerErrors++
      }
    }
  }
  #retireRpc(view: ViewHandle): void {
    this.#rpcRetired.add(view)
    this.#rpcService?.authority.revoke(view)
  }
  #rpcConnected(view: ViewHandle, data: Record<string, unknown> | null | undefined): void {
    const service = this.#rpcService
    if (this.#disposed || !service || !data) return
    const connection = data['connection'],
      frameId = data['frameId'],
      documentId = data['documentId']
    const resource = this.#registry.get<'view', ViewResource>(view, 'view')
    if (
      this.#rpcRetired.has(view) ||
      this.#closing.has(view) ||
      this.#closing.has(resource.window)
    ) {
      // This can be an authentic native event queued before the local lifecycle
      // request. Refuse the exact incarnation without granting a fresh lease or
      // treating a normal retirement race as failure of the entire host.
      if (
        [connection, data['context'], data['generation']].every(
          (value) => Number.isSafeInteger(value) && Number(value) > 0
        )
      ) {
        void this.#transport
          .call('rpc.disconnect', {
            connection,
            context: data['context'],
            generation: data['generation'],
          })
          .catch(() => {})
      }
      return
    }
    const trust = resource.state.trust
    if (
      !Number.isSafeInteger(connection) ||
      Number(connection) < 1 ||
      !Number.isSafeInteger(data['context']) ||
      Number(data['context']) < 1 ||
      !Number.isSafeInteger(data['generation']) ||
      Number(data['generation']) < 1 ||
      trust.kind !== 'application' ||
      data['origin'] !== trust.origin ||
      typeof frameId !== 'string' ||
      typeof documentId !== 'string' ||
      this.#rpcConnections.has(Number(connection))
    )
      throw new Error('Invalid native RPC connection')
    const lease = service.authority.issue(
      view,
      { frameId, documentId, mainFrame: true },
      service.capabilities
    )
    const transport = new CefRpcTransport(
      this.#transport,
      Object.freeze({
        connection: Number(connection),
        context: Number(data['context']),
        generation: Number(data['generation']),
      })
    )
    const server = new RpcServer(
      service.schema,
      service.handlers,
      lease,
      transport,
      service.options
    )
    this.#rpcConnections.set(Number(connection), { view, transport, server })
    void server.closed.then(() => {
      if (this.#rpcConnections.get(Number(connection))?.server === server)
        this.#rpcConnections.delete(Number(connection))
    })
  }
  #rpcPacket(view: ViewHandle | undefined, data: Record<string, unknown> | null | undefined): void {
    if (
      !data ||
      !Number.isSafeInteger(data['connection']) ||
      !Number.isSafeInteger(data['sequence'])
    )
      throw new Error('Invalid native RPC packet metadata')
    const connection = this.#rpcConnections.get(Number(data['connection']))
    if (!connection) return
    if (connection.view !== view) throw new Error('Native RPC view mismatch')
    if (
      data['context'] !== connection.transport.identity.context ||
      data['generation'] !== connection.transport.identity.generation ||
      Number(data['sequence']) < 1
    )
      throw new Error('Native RPC incarnation mismatch')
    const packet = unhex(data['packet'])
    if (data['copiedBytes'] !== packet.byteLength)
      throw new Error('Native RPC copy accounting mismatch')
    connection.transport.receive(packet, Number(data['sequence']))
  }
  #rpcRevoked(
    view: ViewHandle | undefined,
    data: Record<string, unknown> | null | undefined
  ): void {
    if (!data || !Number.isSafeInteger(data['connection'])) return
    const connection = this.#rpcConnections.get(Number(data['connection']))
    if (!connection) return
    if (connection.view !== view) throw new Error('Native RPC view mismatch')
    if (
      data['context'] !== connection.transport.identity.context ||
      data['generation'] !== connection.transport.identity.generation
    )
      throw new Error('Native RPC revocation incarnation mismatch')
    this.#rpcConnections.delete(Number(data['connection']))
    this.#rpcService?.authority.revoke(connection.view)
    connection.transport.end(false)
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

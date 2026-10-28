import { NativeTerminalDriver, type NativeTerminalConfiguration } from './terminal-owner.ts'
import { TerminalService, type TerminalServiceOptions } from './terminal.ts'
import { qualifyCookieProvider } from './credential-proof.ts'
import { isAbsolute } from 'node:path'
import {
  NativeShutdownError,
  NativeTransport,
  type NativeDesktopCapability,
  type NativeEvent,
} from './native-transport.ts'
import { Registry } from './registry.ts'
import { ApplicationLifecycle } from './application-lifecycle.ts'
import { CefDownloads } from './cef-downloads.ts'
import {
  CefBrowserActions,
  validateBrowserAction,
  type NativeBrowserAction,
} from './cef-browser-actions.ts'
import type {
  BrowserActionsBackend,
  BrowserScreenshot,
  ScreenshotOptions,
  BrowserObservation,
} from '../../contracts/src/browser-actions.ts'
import {
  parseCefWindowBounds,
  parseCefWindowState,
  type CefWindowState,
} from './cef-window-state.ts'
export type { CefWindowState } from './cef-window-state.ts'
import { RpcServer } from './rpc.ts'
import { RpcViewAuthority, bindRpcAuthority, type RpcAuthorityBinding } from './rpc-authority.ts'
import { RpcLoopbackServer } from './rpc-loopback.ts'
import {
  fragmentedRpcTransport,
  RpcFragmentBudget,
  NATIVE_RPC_MESSAGE_BYTES,
} from '../../contracts/src/rpc-fragments.ts'
import {
  encodeNativeLoopbackHandoff,
  decodeNativeLoopbackConfirmation,
} from '../../contracts/src/rpc-native-handoff.ts'
import { RpcError, rpcLimits } from '../../contracts/src/rpc.ts'
import type { RpcSchema } from '../../contracts/src/rpc.ts'
import { BinaryStreamReceiver, BinaryStreamSender } from '../../contracts/src/streams.ts'
import { StreamBudget } from '../../contracts/src/stream-budget.ts'
import { STREAM_CHUNK_BYTES } from '../../contracts/src/stream-wire.ts'
import type { BinaryStreamOptions, BinaryStreamSink } from '../../contracts/src/streams.ts'
import { FairWorkScheduler } from './fair-scheduler.ts'
import { CefLaneTransport } from './cef-lane-transport.ts'
import type { RpcHandlers, RpcServerOptions } from './rpc.ts'
import {
  CONTRACT_VERSION,
  normalizeSessionNetworkPolicy,
  PROFILE_CAPABILITY_VERSION,
  BunlyError,
  normalizeUrl,
  originOf,
  requireCapability,
  validateClipboardText,
  validateBounds,
  normalizeViewPresentation,
  parseViewPresentationState,
  normalizeDownloadRequest,
} from '../../contracts/src/index.ts'
import type {
  BrowserBackend,
  ClipboardBackend,
  ApplicationLifecycleBackend,
  ApplicationState,
  ApplicationEvent,
  PolicyScope,
  BackendDescriptor,
  Diagnostics,
  WindowHandle,
  ViewHandle,
  SessionHandle,
  SessionClearOptions,
  SessionClearResult,
  WindowOptions,
  ViewCompositionBackend,
  ViewPresentationOptions,
  ViewPresentationState,
  ViewLayoutMode,
  ViewLayer,
  Bounds,
  WindowEvent,
  WindowState,
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
  DownloadManagementBackend,
  DownloadOperation,
  ScopedDownloadRequest,
  Handle,
  ResourceKind,
} from '../../contracts/src/index.ts'
interface CefRpcConnection {
  readonly view: ViewHandle
  readonly transport: CefRpcTransport
  server: RpcServer<RpcSchema> | undefined
  binding: RpcAuthorityBinding | undefined
}
interface CefRpcService {
  readonly authority: RpcViewAuthority
  readonly schema: RpcSchema
  readonly handlers: RpcHandlers<RpcSchema>
  readonly capabilities: readonly string[]
  readonly options: RpcServerOptions
  readonly listener: RpcLoopbackServer | undefined
}
export interface CefStreamConnection {
  readonly view: ViewHandle
  readonly signal: AbortSignal
  /** Select exactly one endpoint for this native lane. */
  sender(options?: Omit<BinaryStreamOptions, 'budget' | 'owner' | 'signal'>): BinaryStreamSender
  receiver(
    sinks: Readonly<Record<string, BinaryStreamSink>>,
    options?: Omit<BinaryStreamOptions, 'budget' | 'owner' | 'signal'>
  ): BinaryStreamReceiver
}
export interface CefStreamServiceOptions {
  readonly budget?: StreamBudget
}
interface CefStreamService {
  readonly origins: ReadonlySet<string>
  readonly budget: StreamBudget
  readonly connect: (connection: CefStreamConnection) => void | Promise<void>
}
interface CefStreamNativeConnection {
  readonly view: ViewHandle
  readonly transport: CefLaneTransport
  readonly controller: AbortController
}
function nativeRpcOptions(options: RpcServerOptions): RpcServerOptions {
  const limits = rpcLimits({
    maxFrameBytes: NATIVE_RPC_MESSAGE_BYTES,
    maxMetadataBytes: 16 * 1024,
    ...options.limits,
  })
  if (limits.maxFrameBytes > NATIVE_RPC_MESSAGE_BYTES)
    throw new TypeError('Native RPC message limit is 96 KiB')
  return { ...options, limits }
}
interface NativeResource {
  native: number
}
interface WindowSubscription {
  readonly listener: (event: WindowEvent) => void
  readonly dispose: () => void
  active: boolean
}
interface SessionResource extends NativeResource {
  partition: string
  persistence: SessionOptions['persistence']
}
interface ViewResource extends NativeResource {
  window: WindowHandle
  session: SessionHandle
  state: ViewState
  composition: boolean
  layer: ViewLayer
}
interface WindowResource extends NativeResource {
  viewLayout: ViewLayoutMode
}
const MAX_NATIVE_RPC_PACKET = 24 * 1024
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
class CefRpcTransport extends CefLaneTransport {
  constructor(
    native: NativeTransport,
    identity: Readonly<{ connection: number; context: number; generation: number }>
  ) {
    super(native, identity, 'rpc')
  }
}
export type NativeCapabilityGrant =
  | { readonly name: 'file-read' | 'file-write' | 'download'; readonly root: string }
  | {
      readonly name: 'process-execute'
      readonly executable: string
      readonly arguments: readonly string[]
    }
  | {
      readonly name: 'clipboard-read' | 'clipboard-write' | 'dialog-open' | 'dialog-save'
    }
  | {
      readonly name:
        | 'browser-snapshot'
        | 'browser-observe-dom'
        | 'browser-observe-accessibility'
        | 'browser-input'
    }
  | { readonly name: 'browser-evaluate'; readonly expression: string }
  | { readonly name: 'external-url'; readonly origins: readonly string[] }

export type NativeOperationRequest =
  | { readonly name: 'file-read' | 'file-write' | 'download'; readonly path: string }
  | {
      readonly name: 'process-execute'
      readonly executable: string
      readonly arguments: readonly string[]
    }
  | {
      readonly name: 'clipboard-read' | 'clipboard-write' | 'dialog-open' | 'dialog-save'
    }
  | {
      readonly name:
        | 'browser-snapshot'
        | 'browser-observe-dom'
        | 'browser-observe-accessibility'
        | 'browser-input'
    }
  | { readonly name: 'browser-evaluate'; readonly expression: string }
  | { readonly name: 'external-url'; readonly url: string }

export type BrowserPermissionCapability =
  | 'camera'
  | 'microphone'
  | 'display-capture'
  | 'geolocation'
  | 'notifications'
  | 'clipboard'
  | 'multiple-downloads'
  | 'pointer-lock'
export type { PolicyScope } from '../../contracts/src/desktop.ts'
interface NativePolicyScope {
  readonly view: number
  readonly session: number
  readonly generation: number
  readonly mainFrame: string
  readonly document: string
  readonly origin: string
}
interface PolicyScopeRecord {
  readonly epoch: number
  readonly view: ViewHandle
  readonly resource: ViewResource
  readonly documentId: string
  readonly nativeScope: NativePolicyScope
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
function nativePolicyScope(value: unknown): NativePolicyScope {
  const scope = record(value)
  const keys = Object.keys(scope).sort()
  if (
    keys.join(',') !== 'document,generation,mainFrame,origin,session,view' ||
    !Number.isSafeInteger(scope['view']) ||
    Number(scope['view']) < 1 ||
    !Number.isSafeInteger(scope['session']) ||
    Number(scope['session']) < 1 ||
    !Number.isSafeInteger(scope['generation']) ||
    Number(scope['generation']) < 1 ||
    typeof scope['mainFrame'] !== 'string' ||
    scope['mainFrame'].length < 1 ||
    scope['mainFrame'].length > 256 ||
    typeof scope['document'] !== 'string' ||
    scope['document'].length < 1 ||
    scope['document'].length > 256 ||
    typeof scope['origin'] !== 'string' ||
    scope['origin'].length < 1 ||
    scope['origin'].length > 4096 ||
    scope['origin'].includes('\0')
  )
    throw new Error('Invalid native policy scope')
  return Object.freeze({
    view: Number(scope['view']),
    session: Number(scope['session']),
    generation: Number(scope['generation']),
    mainFrame: scope['mainFrame'],
    document: scope['document'],
    origin: scope['origin'],
  })
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
function descriptor(capabilities: readonly NativeDesktopCapability[]): BackendDescriptor {
  return Object.freeze({
    name: 'cef',
    version: '0.1.0-dev.0',
    contractVersion: CONTRACT_VERSION,
    capabilityVersion: PROFILE_CAPABILITY_VERSION,
    capabilities: Object.freeze([
      'window.lifecycle',
      ...capabilities,
      'view.navigate',
      'session.ephemeral',
      'session.persistent',
      'session.cookies',
      'session.protected-cookies',
      'session.cache',
      'session.flush',
      'session.network-policy',
    ] as const),
  })
}
/** Native-owned windows and sessions. This module is never imported by renderer code. */
export class CefBackend
  implements
    BrowserBackend,
    ClipboardBackend,
    ApplicationLifecycleBackend,
    ViewCompositionBackend,
    DownloadManagementBackend,
    BrowserActionsBackend
{
  #descriptor: BackendDescriptor
  get descriptor(): BackendDescriptor {
    return this.#descriptor
  }
  readonly #transport: NativeTransport
  readonly #application = new ApplicationLifecycle()
  readonly #browserActions: CefBrowserActions
  readonly #downloads: CefDownloads
  readonly #registry = new Registry()
  // Native IDs are lookup keys only; public operations still validate opaque registry handles.
  readonly #native = new Map<number, Handle<ResourceKind>>()
  readonly #windowViews = new WeakMap<WindowHandle, Set<ViewHandle>>()
  readonly #sessionViews = new WeakMap<SessionHandle, Set<ViewHandle>>()
  readonly #listeners = new Set<(event: RuntimeEvent) => void>()
  readonly #observers = new Set<(event: NativeEvent) => void>()
  readonly #closing = new WeakMap<Handle<ResourceKind>, Promise<void>>()
  readonly #policyScopes = new WeakMap<PolicyScope, PolicyScopeRecord>()
  readonly #windowSubscriptions = new Map<WindowHandle, Set<WindowSubscription>>()
  #windowSubscriptionCount = 0
  readonly #policyEpochs = new WeakMap<ViewHandle, number>()
  readonly #partitions = new Set<string>()
  #credentialCheck: Promise<void> | undefined
  // Native application grants are one-shot. Fence local lifecycle transitions
  // before their queued native acknowledgement/handshake can arrive.
  readonly #rpcRetired = new WeakSet<ViewHandle>()
  readonly #streamRetired = new WeakSet<ViewHandle>()
  readonly #rpcConnections = new Map<number, CefRpcConnection>()
  readonly #streamConnections = new Map<number, CefStreamNativeConnection>()
  readonly #streamScheduler = new FairWorkScheduler()
  readonly #rpcFragments = new RpcFragmentBudget()
  #nativeConfirmations = 0
  #nativeConfirmationRejections = 0
  #nativeOfferFailure: string | null = null
  #nativeControlClosed = 0
  #nativeRevocations = 0
  #rpcService: CefRpcService | undefined
  #rpcClosing: Promise<void> | undefined
  #streamService: CefStreamService | undefined
  #streamBudget: StreamBudget | undefined
  #streamConfigured = false
  #streamConnectionFailures = 0
  #shutdown: Promise<void> | undefined
  #rpcConfigured = false
  #disposed = false
  #listenerErrors = 0
  /** Native-owned discovery; caller explicitly accepts the non-detaching profile. */
  async createTerminalDriver(options: {
    readonly profile: 'non-detaching'
  }): Promise<NativeTerminalDriver> {
    if (this.#disposed) throw new BunlyError('DISPOSED', 'CEF backend disposed')
    const ready = await this.#transport.ready
    if (this.#disposed || !ready.data?.['terminalOwner'])
      throw new Error('Native terminal owner unavailable')
    return new NativeTerminalDriver(
      ready.data['terminalOwner'] as NativeTerminalConfiguration,
      options.profile
    )
  }
  async createTerminalService(
    options: Omit<TerminalServiceOptions, 'driver'> & { readonly profile: 'non-detaching' }
  ): Promise<TerminalService> {
    return new TerminalService({
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      driver: await this.createTerminalDriver(options),
    })
  }
  readonly closed: Promise<void>
  constructor(transport: NativeTransport) {
    this.#transport = transport
    this.#browserActions = new CefBrowserActions(transport)
    this.#downloads = new CefDownloads(transport, () => {
      this.#listenerErrors++
    })
    this.#descriptor = descriptor(transport.desktopCapabilities)
    if (transport.desktopCapabilities.includes('app.lifecycle')) this.#application.ready(true)
    void transport.ready.then(
      () => this.#application.ready(transport.desktopCapabilities.includes('app.lifecycle')),
      () => this.#application.closed(true)
    )
    transport.onEvent((event) => {
      try {
        if (event.event === 'ready') {
          this.#descriptor = descriptor(transport.desktopCapabilities)
          this.#application.ready(transport.desktopCapabilities.includes('app.lifecycle'))
        }
        this.#event(event)
      } catch (error) {
        transport.fail(error)
      }
    })
    this.closed = transport.closed.then(async () => {
      this.#disposed = true
      this.#downloads.close(transport.failure ?? new NativeShutdownError())
      this.#browserActions.close(transport.failure ?? new NativeShutdownError())
      this.#stopStreams(false)
      const rpcClosed = this.#stopRpc(false)
      for (const kind of ['view', 'window', 'session'] as const)
        for (const handle of this.#registry.handles(kind)) {
          this.#windowViews.delete(handle as WindowHandle)
          this.#sessionViews.delete(handle as SessionHandle)
          this.#registry.dispose(handle, kind)
        }
      this.#native.clear()
      this.#listeners.clear()
      for (const subscriptions of this.#windowSubscriptions.values())
        for (const subscription of subscriptions) subscription.dispose()
      this.#observers.clear()
      this.#partitions.clear()
      try {
        await rpcClosed
      } catch (error) {
        this.#application.closed(true)
        throw error
      }
      this.#application.closed(transport.failure !== null)
      if (transport.failure) throw transport.failure
      if (this.#application.state().outcome === 'failed')
        throw new Error('Native application shutdown failed')
    })
    void this.closed.catch(() => {})
  }
  #active(): void {
    if (this.#disposed) throw new BunlyError('DISPOSED', 'CEF backend disposed')
  }
  whenApplicationReady(options?: OperationOptions): Promise<ApplicationState> {
    return this.#application.whenReady(options)
  }
  applicationState(): ApplicationState {
    requireCapability(this.descriptor, 'app.lifecycle')
    return this.#application.state()
  }
  onApplicationEvent(
    listener: (event: ApplicationEvent) => void,
    options?: OperationOptions
  ): () => void {
    this.#active()
    requireCapability(this.descriptor, 'app.lifecycle')
    return this.#application.subscribe(listener, options)
  }
  quit(): Promise<void> {
    try {
      requireCapability(this.descriptor, 'app.lifecycle')
    } catch (error) {
      return Promise.reject(error)
    }
    return this.dispose()
  }
  async #clipboard(
    scope: PolicyScope,
    operation:
      | 'clipboard.read'
      | 'clipboard.write'
      | 'clipboard.clear'
      | 'clipboard.qualification.empty',
    text: string | undefined,
    options?: OperationOptions
  ): Promise<unknown> {
    this.#active()
    const captured = this.#capturedPolicyScope(scope)
    requireCapability(this.descriptor, 'clipboard.text')
    if (operation === 'clipboard.write') validateClipboardText(text)
    let result: unknown
    try {
      result = await this.#transport.call(
        operation,
        {
          id: captured.resource.native,
          scope: captured.nativeScope,
          ...(operation === 'clipboard.write' ? { text } : {}),
        },
        options?.signal
      )
    } catch (error) {
      if (error instanceof Error) {
        for (const code of [
          'PERMISSION_DENIED',
          'UNSUPPORTED_CAPABILITY',
          'INVALID_ARGUMENT',
          'RESOURCE_IN_USE',
        ] as const)
          if (error.message.startsWith(`${code}:`)) throw new BunlyError(code, error.message)
      }
      throw error
    }
    this.#active()
    this.#capturedPolicyScope(scope)
    return result
  }
  async readClipboardText(scope: PolicyScope, options?: OperationOptions): Promise<string | null> {
    const result = await this.#clipboard(scope, 'clipboard.read', undefined, options)
    if (result === null) return null
    try {
      validateClipboardText(result)
    } catch {
      throw new Error('Malformed native clipboard text')
    }
    return result
  }
  async writeClipboardText(
    scope: PolicyScope,
    text: string,
    options?: OperationOptions
  ): Promise<void> {
    const result = await this.#clipboard(scope, 'clipboard.write', text, options)
    if (result !== null) throw new Error('Malformed native clipboard write receipt')
  }
  async clearClipboard(scope: PolicyScope, options?: OperationOptions): Promise<void> {
    const result = await this.#clipboard(scope, 'clipboard.clear', undefined, options)
    if (result !== null) throw new Error('Malformed native clipboard clear receipt')
  }
  /** @internal Contributor-only metadata preflight; ordinary native hosts reject this operation. */
  async qualifyClipboardEmpty(scope: PolicyScope, options?: OperationOptions): Promise<boolean> {
    const result = await this.#clipboard(scope, 'clipboard.qualification.empty', undefined, options)
    if (typeof result !== 'boolean') throw new Error('Malformed native clipboard preflight receipt')
    return result
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
    const listeners = Array.from(this.#listeners)
    if (event.type === 'window-state-changed')
      this.#emitWindow(event.resource, Object.freeze({ type: 'state-changed', state: event.state }))
    else if (event.type === 'window-bounds-changed')
      this.#emitWindow(
        event.resource,
        Object.freeze({ type: 'bounds-changed', bounds: event.bounds })
      )
    else if (event.type === 'window-fullscreen-transition')
      this.#emitWindow(
        event.resource,
        Object.freeze({
          type: 'fullscreen-transition',
          completed: event.completed,
          state: event.state,
        })
      )
    else if (event.type === 'disposed' && event.resource.kind === 'window')
      this.#emitWindow(event.resource as WindowHandle, Object.freeze({ type: 'closed' }))
    for (const listener of listeners) {
      if (!this.#listeners.has(listener)) continue
      try {
        listener(event)
      } catch {
        this.#listenerErrors++
      }
    }
  }
  #emitWindow(window: WindowHandle, event: WindowEvent): void {
    const subscriptions = this.#windowSubscriptions.get(window)
    if (!subscriptions) return
    for (const subscription of Array.from(subscriptions)) {
      if (!subscription.active) continue
      if (
        event.type !== 'closed' &&
        (this.#disposed || this.#closing.has(window) || this.#registry.isDisposed(window, 'window'))
      )
        break
      if (event.type === 'closed') subscription.dispose()
      try {
        subscription.listener(event)
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
    const persistentCookies = options.persistentCookies
    if (
      persistentCookies !== undefined &&
      (persistentCookies !== 'os-protected' || persistence !== 'persistent')
    )
      throw new BunlyError(
        'INVALID_ARGUMENT',
        'Protected cookies require explicit persistent-session intent'
      )
    if (partition === 'bunly-internal-credential-proof')
      throw new BunlyError('INVALID_ARGUMENT', 'Reserved native credential partition')
    const network =
      options.network === undefined ? undefined : normalizeSessionNetworkPolicy(options.network)
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
      if (persistentCookies !== undefined) {
        this.#credentialCheck ??= qualifyCookieProvider(this.#transport, persistentRoot!)
        await this.#credentialCheck
        this.#active()
      }
      const native = this.#createdId(
        await this.#transport.call('session.create', {
          persistence,
          partition,
          ...(persistentCookies === undefined ? {} : { persistentCookies }),
          ...(persistentRoot === undefined ? {} : { persistentRoot }),
          ...(network === undefined ? {} : { network }),
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
    const requestedLayout = options.viewLayout
    const viewLayout = requestedLayout ?? 'stack'
    if (viewLayout !== 'stack' && viewLayout !== 'manual')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid view layout mode')
    if (viewLayout === 'manual') requireCapability(this.descriptor, 'view.composition')
    if (
      typeof options.title !== 'string' ||
      options.title.length > 1024 ||
      options.title.includes('\0')
    )
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid window title')
    const native = this.#createdId(
      await this.#transport.call('window.create', {
        title: options.title,
        ...options.bounds,
        ...(requestedLayout === undefined ? {} : { viewLayout }),
      })
    )
    this.#active()
    const handle = this.#remember('window', { native, viewLayout } satisfies WindowResource)
    this.#windowViews.set(handle, new Set())
    this.#emit({ type: 'created', resource: handle })
    return handle
  }
  async createView(options: ViewOptions): Promise<ViewHandle> {
    this.#active()
    const { window: windowHandle, session: sessionHandle } = options
    const window = this.#registry.get<'window', WindowResource>(windowHandle, 'window')
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
    if (window.viewLayout === 'manual') requireCapability(this.descriptor, 'view.composition')
    if (
      window.viewLayout === 'stack' &&
      (options.presentation !== undefined || options.layer !== undefined)
    )
      throw new BunlyError('INVALID_ARGUMENT', 'View presentation requires a manual-layout window')
    const presentation =
      window.viewLayout === 'manual' ? normalizeViewPresentation(options.presentation) : undefined
    const layer = options.layer ?? 'content'
    if (layer !== 'content' && layer !== 'overlay')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid view layer')
    if (layer === 'overlay' && (trust.kind !== 'application' || trust.origin !== 'app://ui'))
      throw new BunlyError(
        'PERMISSION_DENIED',
        'Overlays require an application-owned app://ui document'
      )
    const created = await this.#transport.call('view.create', {
      window: window.native,
      session: session.native,
      url,
      trust,
      ...(presentation === undefined ? {} : { presentation, layer }),
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
      composition: presentation !== undefined,
      layer,
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
    if (resource.layer === 'overlay' && originOf(url) !== 'app://ui')
      throw new BunlyError('PERMISSION_DENIED', 'Overlay navigation must remain application-owned')
    this.#policyEpochs.set(view, (this.#policyEpochs.get(view) ?? 0) + 1)
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
  /** Capture authority for exactly the currently ready native document. */
  async capturePolicyScope(view: ViewHandle): Promise<PolicyScope> {
    this.#active()
    const resource = this.#liveView(view)
    const session = this.#registry.get<'session', SessionResource>(resource.session, 'session')
    const documentId = resource.state.documentId
    const epoch = this.#policyEpochs.get(view) ?? 0
    const scope = nativePolicyScope(
      await this.#transport.call('policy.scope', { id: resource.native })
    )
    this.#active()
    const current = this.#liveView(view)
    if (
      current !== resource ||
      current.state.documentId !== documentId ||
      (this.#policyEpochs.get(view) ?? 0) !== epoch ||
      scope.document !== documentId ||
      scope.view !== resource.native ||
      scope.session !== session.native
    )
      throw new BunlyError('PERMISSION_DENIED', 'Policy document changed during scope capture')
    const token = Object.freeze({}) as PolicyScope
    this.#policyScopes.set(token, { view, resource, documentId, nativeScope: scope, epoch })
    return token
  }
  /** Revalidate a retained scope against the current native document, without granting an OS operation. */
  async validatePolicyScope(scope: PolicyScope): Promise<void> {
    this.#active()
    const captured = this.#capturedPolicyScope(scope)
    const current = nativePolicyScope(
      await this.#transport.call('policy.scope', { id: captured.resource.native })
    )
    this.#active()
    this.#capturedPolicyScope(scope)
    for (const key of ['view', 'session', 'generation', 'mainFrame', 'document', 'origin'] as const)
      if (current[key] !== captured.nativeScope[key])
        throw new BunlyError('PERMISSION_DENIED', 'Retained native policy scope changed')
  }
  /** Synchronous local revocation fence, including navigation before its native acknowledgment.
   * This does not replace fresh native validation or grant an operation by itself.
   */
  isPolicyScopeLocallyCurrent(scope: PolicyScope): boolean {
    try {
      this.#active()
      this.#capturedPolicyScope(scope)
      return true
    } catch {
      return false
    }
  }
  /** @internal Contributor fixture only; ordinary native builds reject this command.
   * Requests one fixed native user-activation fixture, never arbitrary evaluation or input.
   */
  async qualifyPolicyGesture(scope: PolicyScope): Promise<void> {
    this.#active()
    const captured = this.#capturedPolicyScope(scope)
    await this.#transport.call('policy.qualification.activate', {
      id: captured.resource.native,
      scope: captured.nativeScope,
    })
  }
  /** @internal Fixed, native-bound contributor fault. Ordinary builds reject it.
   * No page-supplied task or PID. Success means native dispatch was accepted, not that
   * the renderer exited; the qualifier separately requires the actual exit.
   */
  async qualifyRendererCrash(scope: PolicyScope): Promise<void> {
    this.#active()
    const captured = this.#capturedPolicyScope(scope)
    const result = await this.#transport.call('rpc.qualification.renderer.crash', {
      id: captured.resource.native,
      scope: captured.nativeScope,
    })
    if (result !== null) throw new Error('Invalid native renderer injection receipt')
    // The intended side effect revokes this document. Do not require it to stay
    // live after the native action, or turn a real termination into stale-scope failure.
  }
  /** @internal Fixed contributor-only real Chromium throttle probe. */
  async qualifyTransportThrottle(scope: PolicyScope, rate: 1 | 4): Promise<void> {
    this.#active()
    if (rate !== 1 && rate !== 4)
      throw new BunlyError('INVALID_ARGUMENT', 'Expected fixed throttle rate 1 or 4')
    const captured = this.#capturedPolicyScope(scope)
    await this.#transport.call('rpc.qualification.throttle', {
      id: captured.resource.native,
      scope: captured.nativeScope,
      rate,
    })
  }
  /** Configure a scoped grant over the private application-to-host control pipe. */
  async grantNativeCapability(
    scope: PolicyScope,
    capability: NativeCapabilityGrant
  ): Promise<void> {
    this.#active()
    const captured = this.#capturedPolicyScope(scope)
    let prepared = capability
    if (capability.name.startsWith('browser-')) {
      const expected = capability.name === 'browser-evaluate' ? ['name', 'expression'] : ['name']
      if (
        Object.keys(capability).length !== expected.length ||
        expected.some((key) => !Object.hasOwn(capability, key))
      )
        throw new BunlyError('INVALID_ARGUMENT', 'Unexpected browser grant fields')
      if (capability.name === 'browser-evaluate') {
        const expression = capability.expression
        validateBrowserAction({ kind: 'evaluate', expression })
        prepared = { name: 'browser-evaluate', expression }
      } else if (
        capability.name === 'browser-snapshot' ||
        capability.name === 'browser-observe-dom' ||
        capability.name === 'browser-observe-accessibility' ||
        capability.name === 'browser-input'
      )
        prepared = { name: capability.name }
      else throw new BunlyError('UNSUPPORTED_CAPABILITY', 'Unknown browser grant')
    }
    await this.#transport.call('policy.native.grant', {
      id: captured.resource.native,
      scope: captured.nativeScope,
      capability: structuredClone(prepared),
    })
  }
  /**
   * Policy-only diagnostic. A matching grant is reported as unavailable and
   * never performs an OS action. Discover usable adapters through capabilities;
   * their execution methods independently perform the final native policy gate.
   */
  async authorizeNativeOperation(
    scope: PolicyScope,
    request: NativeOperationRequest
  ): Promise<'unavailable'> {
    this.#active()
    const captured = this.#capturedPolicyScope(scope)
    const result = record(
      await this.#transport.call('policy.native.check', {
        id: captured.resource.native,
        scope: captured.nativeScope,
        request: structuredClone(request),
      })
    )['status']
    if (result !== 'unavailable') throw new Error('Invalid native policy result')
    return result
  }
  async setBrowserApplicationPolicy(
    scope: PolicyScope,
    permission: BrowserPermissionCapability,
    decision: 'granted' | 'denied'
  ): Promise<void> {
    return this.#browserDecision(scope, permission, decision, 'application-policy')
  }
  async recordBrowserUserDecision(
    scope: PolicyScope,
    permission: BrowserPermissionCapability,
    decision: 'granted' | 'denied'
  ): Promise<void> {
    return this.#browserDecision(scope, permission, decision, 'user-decision')
  }
  async #browserDecision(
    scope: PolicyScope,
    permission: BrowserPermissionCapability,
    decision: 'granted' | 'denied',
    source: 'application-policy' | 'user-decision'
  ): Promise<void> {
    this.#active()
    const captured = this.#capturedPolicyScope(scope)
    await this.#transport.call('policy.browser.decision', {
      id: captured.resource.native,
      scope: captured.nativeScope,
      permission,
      decision,
      source,
    })
  }
  #capturedPolicyScope(scope: PolicyScope): PolicyScopeRecord {
    if (!scope || typeof scope !== 'object')
      throw new BunlyError('PERMISSION_DENIED', 'Policy scope is foreign or forged')
    const captured = this.#policyScopes.get(scope)
    if (!captured) throw new BunlyError('PERMISSION_DENIED', 'Policy scope is foreign or forged')
    const current = this.#liveView(captured.view)
    if (
      current !== captured.resource ||
      current.state.documentId !== captured.documentId ||
      (this.#policyEpochs.get(captured.view) ?? 0) !== captured.epoch
    )
      throw new BunlyError('PERMISSION_DENIED', 'Policy scope is stale after document change')
    return captured
  }
  #liveView(view: ViewHandle): ViewResource {
    const resource = this.#registry.get<'view', ViewResource>(view, 'view')
    if (this.#closing.has(view) || this.#closing.has(resource.window))
      throw new BunlyError('DISPOSED', 'View is closing')
    return resource
  }
  #liveWindow(window: WindowHandle): NativeResource {
    this.#active()
    const resource = this.#registry.get<'window', NativeResource>(window, 'window')
    if (this.#closing.has(window)) throw new BunlyError('DISPOSED', 'Window is closing')
    return resource
  }
  async #windowStateOperation(
    window: WindowHandle,
    operation:
      | 'window.state'
      | 'window.minimize'
      | 'window.restore'
      | 'window.activate'
      | 'window.maximize'
      | 'window.fullscreen',
    options?: OperationOptions,
    extra: Readonly<Record<string, unknown>> = {}
  ): Promise<CefWindowState> {
    const resource = this.#liveWindow(window)
    if (operation === 'window.maximize' || operation === 'window.fullscreen')
      requireCapability(this.descriptor, 'window.state')
    const result = await this.#transport.call(
      operation,
      { id: resource.native, ...extra },
      options?.signal
    )
    this.#liveWindow(window)
    return parseCefWindowState(result)
  }
  /** @internal Read-only contributor fixture; ordinary builds reject it. */
  async qualifyWindowVisibility(window: WindowHandle): Promise<unknown> {
    const resource = this.#liveWindow(window)
    const value = await this.#transport.call('window.qualification.visibility', {
      id: resource.native,
    })
    this.#liveWindow(window)
    return value
  }
  /** Snapshot of the actual owned CEF window on its UI thread; never cached intent. */
  windowState(window: WindowHandle, options?: OperationOptions): Promise<CefWindowState> {
    return this.#windowStateOperation(window, 'window.state', options)
  }
  /** Request minimization and return immediate native readback, not transition completion. */
  minimizeWindow(window: WindowHandle, options?: OperationOptions): Promise<CefWindowState> {
    return this.#windowStateOperation(window, 'window.minimize', options)
  }
  /** Request activation; actual focus depends on the OS. Returned state is not promised intent. */
  activateWindow(window: WindowHandle, options?: OperationOptions): Promise<CefWindowState> {
    return this.#windowStateOperation(window, 'window.activate', options)
  }
  /** CEF Restore restores minimized/maximized windows; use showWindow to unhide. */
  restoreWindow(window: WindowHandle, options?: OperationOptions): Promise<CefWindowState> {
    return this.#windowStateOperation(window, 'window.restore', options)
  }
  maximizeWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState> {
    return this.#windowStateOperation(window, 'window.maximize', options)
  }
  async setWindowFullscreen(
    window: WindowHandle,
    fullscreen: boolean,
    options?: OperationOptions
  ): Promise<WindowState> {
    this.#liveWindow(window)
    if (typeof fullscreen !== 'boolean')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid fullscreen flag')
    return this.#windowStateOperation(window, 'window.fullscreen', options, { fullscreen })
  }
  async showWindow(
    window: WindowHandle,
    visible: boolean,
    options?: OperationOptions
  ): Promise<void> {
    const resource = this.#liveWindow(window)
    if (typeof visible !== 'boolean') throw new BunlyError('INVALID_ARGUMENT', 'Invalid visibility')
    await this.#transport.call(
      visible ? 'window.show' : 'window.hide',
      { id: resource.native },
      options?.signal
    )
    this.#liveWindow(window)
  }
  async resizeWindow(
    window: WindowHandle,
    width: number,
    height: number,
    options?: OperationOptions
  ): Promise<void> {
    const resource = this.#liveWindow(window)
    validateBounds({ x: 0, y: 0, width, height })
    await this.#transport.call(
      'window.resize',
      { id: resource.native, width, height },
      options?.signal
    )
    this.#liveWindow(window)
  }
  async windowBounds(window: WindowHandle, options?: OperationOptions): Promise<Bounds> {
    const resource = this.#liveWindow(window)
    requireCapability(this.descriptor, 'window.geometry')
    const result = await this.#transport.call(
      'window.bounds',
      { id: resource.native },
      options?.signal
    )
    this.#liveWindow(window)
    return parseCefWindowBounds(result)
  }
  async setWindowBounds(
    window: WindowHandle,
    bounds: Bounds,
    options?: OperationOptions
  ): Promise<Bounds> {
    const resource = this.#liveWindow(window)
    requireCapability(this.descriptor, 'window.geometry')
    validateBounds(bounds)
    const result = await this.#transport.call(
      'window.bounds.set',
      { id: resource.native, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      options?.signal
    )
    this.#liveWindow(window)
    return parseCefWindowBounds(result)
  }
  onWindowEvent(
    window: WindowHandle,
    listener: (event: WindowEvent) => void,
    options?: OperationOptions
  ): () => void {
    this.#liveWindow(window)
    requireCapability(this.descriptor, 'window.state')
    options?.signal?.throwIfAborted()
    if (typeof listener !== 'function')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid window listener')
    if (this.#windowSubscriptionCount >= 128)
      throw new BunlyError('RESOURCE_IN_USE', 'Window listener capacity exceeded')
    const subscriptions = this.#windowSubscriptions.get(window) ?? new Set<WindowSubscription>()
    const signal = options?.signal
    const dispose = () => {
      if (!subscription.active) return
      subscription.active = false
      subscriptions.delete(subscription)
      this.#windowSubscriptionCount--
      if (subscriptions.size === 0) this.#windowSubscriptions.delete(window)
      signal?.removeEventListener('abort', dispose)
    }
    const subscription: WindowSubscription = { listener, dispose, active: true }
    subscriptions.add(subscription)
    this.#windowSubscriptions.set(window, subscriptions)
    this.#windowSubscriptionCount++
    signal?.addEventListener('abort', dispose, { once: true })
    return dispose
  }
  async focusView(view: ViewHandle, options?: OperationOptions): Promise<void> {
    const resource = this.#liveView(view)
    if (resource.composition) requireCapability(this.descriptor, 'view.composition')
    await this.#transport.call('view.focus', { id: resource.native }, options?.signal)
    this.#liveView(view)
  }
  async viewPresentation(
    view: ViewHandle,
    options?: OperationOptions
  ): Promise<ViewPresentationState> {
    const resource = this.#liveView(view)
    requireCapability(this.descriptor, 'view.composition')
    if (!resource.composition) return unsupported('view.composition')
    const value = await this.#transport.call(
      'view.presentation',
      { id: resource.native },
      options?.signal
    )
    this.#liveView(view)
    return parseViewPresentationState(value)
  }
  async setViewPresentation(
    view: ViewHandle,
    presentation: ViewPresentationOptions,
    options?: OperationOptions
  ): Promise<ViewPresentationState> {
    const resource = this.#liveView(view)
    requireCapability(this.descriptor, 'view.composition')
    if (!resource.composition) return unsupported('view.composition')
    const normalized = normalizeViewPresentation(presentation)
    const value = await this.#transport.call(
      'view.present',
      { id: resource.native, presentation: normalized },
      options?.signal
    )
    this.#liveView(view)
    return parseViewPresentationState(value)
  }
  async focusNextView(
    window: WindowHandle,
    reverse = false,
    options?: OperationOptions
  ): Promise<ViewHandle | null> {
    const resource = this.#liveWindow(window)
    requireCapability(this.descriptor, 'view.composition')
    if (typeof reverse !== 'boolean')
      throw new BunlyError('INVALID_ARGUMENT', 'Invalid traversal direction')
    const value = await this.#transport.call(
      'window.focus.next',
      { id: resource.native, reverse },
      options?.signal
    )
    this.#liveWindow(window)
    if (value === null) return null
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'id')
      throw new Error('Malformed native focus target')
    const native = this.#createdId(value)
    const target = this.#native.get(native)
    if (!target || target.kind !== 'view') throw new Error('Malformed native focus target')
    const view = target as ViewHandle
    if (this.#liveView(view).window !== window)
      throw new Error('Native focus target has a different owner')
    return view
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
    this.#retireRpc(view)
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
  async #browserAction(
    view: ViewHandle,
    action: NativeBrowserAction,
    options?: OperationOptions
  ): Promise<unknown> {
    const resource = this.#liveView(view)
    const capability = {
      screenshot: 'view.snapshot',
      evaluate: 'view.evaluate',
      input: 'view.input.synthetic',
      dom: 'view.observe-dom',
      accessibility: 'view.observe-accessibility',
    } as const
    requireCapability(this.descriptor, capability[action.kind])
    let token: PolicyScope | undefined
    return this.#browserActions.run(
      resource.native,
      async () => {
        token = await this.capturePolicyScope(view)
        return { ...this.#capturedPolicyScope(token).nativeScope }
      },
      action,
      () => {
        this.#active()
        if (this.#liveView(view) !== resource)
          throw new BunlyError('DISPOSED', 'Browser target changed')
        if (token) this.#capturedPolicyScope(token)
      },
      options?.signal
    )
  }
  async captureScreenshot(
    view: ViewHandle,
    options?: ScreenshotOptions
  ): Promise<BrowserScreenshot> {
    return (await this.#browserAction(
      view,
      { kind: 'screenshot', width: options?.maxWidth ?? 1024, height: options?.maxHeight ?? 768 },
      options
    )) as BrowserScreenshot
  }
  async snapshot(view: ViewHandle, options?: OperationOptions): Promise<Uint8Array> {
    return (await this.captureScreenshot(view, options)).data
  }
  async observeDom(view: ViewHandle, options?: OperationOptions): Promise<BrowserObservation> {
    return (await this.#browserAction(view, { kind: 'dom' }, options)) as BrowserObservation
  }
  async accessibilityTree(
    view: ViewHandle,
    options?: OperationOptions
  ): Promise<BrowserObservation> {
    return (await this.#browserAction(
      view,
      { kind: 'accessibility' },
      options
    )) as BrowserObservation
  }
  async evaluate(
    view: ViewHandle,
    expression: string,
    options?: OperationOptions
  ): Promise<unknown> {
    return this.#browserAction(view, { kind: 'evaluate', expression }, options)
  }
  async input(view: ViewHandle, action: InputAction, options?: OperationOptions): Promise<void> {
    await this.#browserAction(view, { kind: 'input', action }, options)
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
    view: ViewHandle,
    request: DownloadRequest,
    options?: OperationOptions
  ): Promise<DownloadResult> {
    requireCapability(this.descriptor, 'download.manage')
    if (!request?.destination)
      throw new BunlyError('INVALID_ARGUMENT', 'Downloads require an explicit scoped destination')
    const operation = await this.startDownload(
      view,
      { url: request.url, destination: request.destination },
      options
    )
    const result = await operation.completed
    if (result.status === 'failed') throw new Error(`Native download failed: ${result.failure}`)
    return Object.freeze({ status: result.status, bytesWritten: result.bytesWritten })
  }
  async startDownload(
    view: ViewHandle,
    request: ScopedDownloadRequest,
    options?: OperationOptions
  ): Promise<DownloadOperation> {
    this.#liveView(view)
    requireCapability(this.descriptor, 'download.manage')
    const normalized = normalizeDownloadRequest(request)
    if (options?.signal?.aborted)
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    const token = await this.capturePolicyScope(view)
    const captured = this.#capturedPolicyScope(token)
    return this.#downloads.start(
      captured.resource.native,
      { ...captured.nativeScope },
      normalized,
      () => {
        this.#active()
        this.#capturedPolicyScope(token)
      },
      options?.signal
    )
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
    const application = this.#application.diagnostics()
    return {
      windows: this.#registry.count('window'),
      views: this.#registry.count('view'),
      sessions: this.#registry.count('session'),
      listeners:
        this.#listeners.size +
        this.#observers.size +
        this.#windowSubscriptionCount +
        application.listeners +
        application.readyWaiters +
        this.#downloads.listenerCount,
      listenerErrors: this.#listenerErrors + application.listenerErrors,
    }
  }
  /** Trusted-backend pipe accounting only; not renderer authority or native RSS. */
  nativeTransportDiagnostics(): ReturnType<NativeTransport['diagnostics']> {
    return this.#transport.diagnostics()
  }
  async nativeDiagnostics(): Promise<unknown> {
    return this.#transport.call('diagnostics')
  }
  /** Configure the independent native binary lane before creating any view.
   * The callback receives the opaque local ViewHandle as budget owner; renderer
   * packet metadata is never promoted to application authority.
   */
  serveStreams(
    origins: readonly string[],
    connect: (connection: CefStreamConnection) => void | Promise<void>,
    options: CefStreamServiceOptions = {}
  ): () => void {
    this.#active()
    if (
      this.#streamConfigured ||
      this.#registry.count('view') !== 0 ||
      this.#registry.count('session') !== 0
    )
      throw new BunlyError(
        'INVALID_ARGUMENT',
        'Configure one stream service before creating sessions or views'
      )
    if (
      typeof connect !== 'function' ||
      !origins.length ||
      origins.length > 32 ||
      origins.some((value) => originOf(value) !== value || value === 'null')
    )
      throw new TypeError('Supply exact approved stream origins and a connection callback')
    const budget = options.budget ?? new StreamBudget()
    if (!(budget instanceof StreamBudget)) throw new TypeError('Invalid shared stream budget')
    const service: CefStreamService = {
      origins: new Set(origins),
      budget,
      connect,
    }
    this.#streamConfigured = true
    this.#streamService = service
    this.#streamBudget = budget
    return () => {
      if (this.#streamService === service) this.#stopStreams(true)
    }
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
    const normalized = nativeRpcOptions(options)
    const authority = new RpcViewAuthority(this, origins)
    this.#rpcConfigured = true
    this.#rpcService = {
      authority,
      schema,
      handlers: handlers as RpcHandlers<RpcSchema>,
      capabilities: Object.freeze([...capabilities]),
      options: normalized,
      listener: undefined,
    }
    return () => {
      if (this.#rpcService?.authority === authority)
        void this.#stopRpc(true).catch((error) => this.#transport.fail(error))
    }
  }

  /** @internal Experimental contributor-only CEF candidate; ordinary native builds
   * reject it: general Chromium app-scheme loopback permission is not a supported
   * shipping capability. The named contributor fixture has a separately recorded
   * reachability decision; no security flag or automatic fallback is used.
   * No listener exists until called. Configure before sessions/views
   * so the host can admit exactly this numeric-loopback port in application CSP.
   */
  async serveLoopbackRpc<S extends RpcSchema>(
    schema: S,
    handlers: RpcHandlers<S>,
    origins: readonly string[],
    capabilities: readonly string[],
    options: RpcServerOptions = {}
  ): Promise<() => Promise<void>> {
    this.#active()
    if (
      this.#rpcConfigured ||
      this.#registry.count('view') !== 0 ||
      this.#registry.count('session') !== 0
    )
      throw new BunlyError(
        'INVALID_ARGUMENT',
        'Configure one RPC service before creating sessions or views'
      )
    const normalized = nativeRpcOptions(options)
    const authority = new RpcViewAuthority(this, origins)
    this.#rpcConfigured = true
    let listener: RpcLoopbackServer
    try {
      listener = new RpcLoopbackServer({
        maxFrameBytes: NATIVE_RPC_MESSAGE_BYTES,
        requireNativeConfirmation: true,
        accept: (lease, transport, identity) => {
          const current = [...this.#rpcConnections.entries()].find(
            ([, connection]) => connection.binding?.identity === identity.identity
          )
          const service = this.#rpcService
          if (
            !current ||
            !service ||
            service.authority !== authority ||
            service.listener !== listener ||
            current[1].server ||
            current[1].binding?.signal.aborted
          )
            throw new RpcError('REVOKED', 'Native loopback owner retired')
          const [id, connection] = current
          const server = new RpcServer(
            service.schema,
            service.handlers,
            lease,
            transport,
            service.options
          )
          connection.server = server
          void server.closed.then(() => {
            if (this.#rpcConnections.get(id) === connection) {
              this.#rpcConnections.delete(id)
              connection.transport.end(true)
            }
          })
        },
      })
    } catch (error) {
      authority.dispose()
      throw error
    }
    const service: CefRpcService = {
      authority,
      schema,
      handlers: handlers as RpcHandlers<RpcSchema>,
      capabilities: Object.freeze([...capabilities]),
      options: normalized,
      listener,
    }
    this.#rpcService = service
    try {
      await this.#transport.call('rpc.loopback.configure', {
        port: Number(new URL(listener.endpoint).port),
      })
      this.#active()
      if (this.#rpcService !== service)
        throw new RpcError('REVOKED', 'RPC service retired during setup')
    } catch (error) {
      await this.#stopRpc(true)
      throw error
    }
    return () =>
      this.#rpcService === service ? this.#stopRpc(true) : (this.#rpcClosing ?? Promise.resolve())
  }

  #stopRpc(tellNative: boolean): Promise<void> {
    const service = this.#rpcService
    if (!service) return this.#rpcClosing ?? Promise.resolve()
    this.#rpcService = undefined
    service.authority.dispose()
    for (const connection of this.#rpcConnections.values()) connection.transport.end(tellNative)
    this.#rpcConnections.clear()
    this.#rpcClosing = service.listener?.close() ?? Promise.resolve()
    return this.#rpcClosing
  }
  #stopStreams(tellNative: boolean): void {
    this.#streamService = undefined
    for (const connection of this.#streamConnections.values()) {
      connection.controller.abort(new Error('Native stream service retired'))
      connection.transport.end(tellNative)
    }
    this.#streamConnections.clear()
  }

  /** Await admitted RPC work and actual native reply receipts before controlled
   * teardown. Producers must be quiescent; this never grants or restores authority. */
  async drainRpc(view: ViewHandle): Promise<void> {
    this.#active()
    const resource = this.#liveView(view)
    const document = resource.state.documentId
    const current = [...this.#rpcConnections.entries()].find(([, value]) => value.view === view)
    if (!current?.[1].server) throw new RpcError('REVOKED', 'Native RPC document unavailable')
    const [id, connection] = current
    await connection.server!.whenIdle()
    this.#active()
    if (
      this.#liveView(view) !== resource ||
      resource.state.documentId !== document ||
      this.#rpcConnections.get(id) !== connection
    )
      throw new RpcError('REVOKED', 'Native RPC document changed during drain')
  }

  rpcDiagnostics() {
    return {
      connections: this.#rpcConnections.size,
      nativeConfirmations: this.#nativeConfirmations,
      nativeConfirmationRejections: this.#nativeConfirmationRejections,
      nativeOfferFailure: this.#nativeOfferFailure,
      nativeControlClosed: this.#nativeControlClosed,
      nativeRevocations: this.#nativeRevocations,
      fragments: this.#rpcFragments.diagnostics(),
      loopback: this.#rpcService?.listener?.diagnostics() ?? null,
      loopbackAuthentication: this.#rpcService?.listener?.authenticationDiagnostics() ?? null,
      servers: [...this.#rpcConnections.values()].flatMap((connection) =>
        connection.server ? [connection.server.diagnostics()] : []
      ),
    }
  }
  streamDiagnostics() {
    return {
      connections: this.#streamConnections.size,
      connectionFailures: this.#streamConnectionFailures,
      budget: this.#streamBudget?.diagnostics() ?? null,
      scheduling: this.#streamScheduler.diagnostics(),
    }
  }
  dispose(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    if (this.#disposed) return this.closed
    this.#disposed = true
    this.#application.requested()
    this.#stopStreams(true)
    const rpcClosed = this.#stopRpc(true)
    const nativeClosed = this.#transport.diagnostics().closed
      ? this.closed
      : this.#transport.call('quit').then(
          () => this.closed,
          (error: unknown) => {
            // Last-window closure may finish the host before a redundant quit is acknowledged.
            // Only its explicit clean-shutdown cancellation is idempotent, not an RPC failure.
            if (
              error instanceof NativeShutdownError &&
              this.#transport.diagnostics().closed &&
              this.#transport.failure === null
            )
              return this.closed
            throw error
          }
        )
    this.#shutdown = Promise.all([rpcClosed, nativeClosed])
      .then(() => {})
      .catch((error) => {
        this.#transport.fail(error)
        throw error
      })
    return this.#shutdown
  }
  #event(event: NativeEvent): void {
    if (event.event === 'app.quitting' && this.descriptor.capabilities.includes('app.lifecycle')) {
      if (event.target !== undefined || !event.data || Object.keys(event.data).length !== 1)
        throw new Error('Malformed native application quitting event')
      // Native-initiated quit fences local calls before application callbacks run.
      this.#disposed = true
      this.#application.quitting(event.data['reason'])
    }
    this.#downloads.event(event)
    this.#browserActions.event(event)
    const handle = event.target === undefined ? undefined : this.#native.get(event.target)
    const window = handle?.kind === 'window' ? (handle as WindowHandle) : undefined
    const view = handle?.kind === 'view' ? (handle as ViewHandle) : undefined
    if (event.event === 'window.closed' && window) this.#dropWindow(window)
    else if (
      window &&
      !this.#closing.has(window) &&
      this.descriptor.capabilities.includes('window.state') &&
      event.event === 'window.state-changed'
    )
      this.#emit({
        type: 'window-state-changed',
        resource: window,
        state: parseCefWindowState(event.data),
      })
    else if (
      window &&
      !this.#closing.has(window) &&
      this.descriptor.capabilities.includes('window.geometry') &&
      event.event === 'window.bounds-changed'
    )
      this.#emit({
        type: 'window-bounds-changed',
        resource: window,
        bounds: parseCefWindowBounds(event.data),
      })
    else if (
      window &&
      !this.#closing.has(window) &&
      this.descriptor.capabilities.includes('window.state') &&
      event.event === 'window.fullscreen-transition'
    ) {
      if (
        !event.data ||
        Object.keys(event.data).sort().join(',') !== 'completed,state' ||
        typeof event.data['completed'] !== 'boolean'
      )
        throw new Error('Malformed native fullscreen transition')
      this.#emit({
        type: 'window-fullscreen-transition',
        resource: window,
        completed: event.data['completed'],
        state: parseCefWindowState(event.data['state']),
      })
    } else if (event.event === 'view.closed' && view) this.#dropView(view)
    else if (view && (event.event === 'view.navigating' || event.event === 'view.loaded')) {
      if (typeof event.data?.['url'] !== 'string') throw new Error('Missing native navigation URL')
      // Initial native-approved navigation establishes the first document. Only
      // subsequent/untrusted navigation retires it; the native callback owns
      // this eligibility bit, never the page.
      if (event.event === 'view.navigating' && event.data['applicationTrust'] !== true)
        this.#retireRpc(view)
      const resource = this.#registry.get<'view', ViewResource>(view, 'view')
      const url = normalizeUrl(event.data['url'])
      if (resource.layer === 'overlay' && originOf(url) !== 'app://ui')
        throw new Error('Native overlay escaped its application origin')
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
    else if (view && event.event === 'stream.connected') this.#streamConnected(view, event.data)
    else if (event.event === 'stream.packet') this.#streamPacket(view, event.data)
    else if (event.event === 'stream.revoked') this.#streamRevoked(view, event.data)
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
    this.#streamRetired.add(view)
    for (const [id, connection] of this.#streamConnections) {
      if (connection.view !== view) continue
      this.#streamConnections.delete(id)
      connection.controller.abort(new Error('Native stream document retired'))
      connection.transport.end(true)
    }
  }
  #streamConnected(view: ViewHandle, data: Record<string, unknown> | null | undefined): void {
    if (this.#disposed || !data) return
    const resource = this.#registry.get<'view', ViewResource>(view, 'view')
    const connection = data['connection']
    const validIdentity = [connection, data['context'], data['generation']].every(
      (value) => Number.isSafeInteger(value) && Number(value) > 0
    )
    const disconnect = () => {
      if (validIdentity)
        void this.#transport
          .call('stream.disconnect', {
            connection,
            context: data['context'],
            generation: data['generation'],
          })
          .catch(() => {})
    }
    const service = this.#streamService
    if (!service) {
      disconnect()
      return
    }
    if (
      this.#streamRetired.has(view) ||
      this.#closing.has(view) ||
      this.#closing.has(resource.window)
    ) {
      disconnect()
      return
    }
    const trust = resource.state.trust
    if (
      !validIdentity ||
      trust.kind !== 'application' ||
      originOf(resource.state.url) !== trust.origin ||
      data['origin'] !== trust.origin ||
      typeof data['frameId'] !== 'string' ||
      data['frameId'].length < 1 ||
      data['frameId'].length > 256 ||
      data['documentId'] !== resource.state.documentId ||
      this.#streamConnections.has(Number(connection))
    )
      throw new Error('Invalid native stream connection')
    if (!service.origins.has(trust.origin)) {
      disconnect()
      return
    }
    const transport = new CefLaneTransport(
      this.#transport,
      Object.freeze({
        connection: Number(connection),
        context: Number(data['context']),
        generation: Number(data['generation']),
      }),
      'stream',
      this.#streamScheduler,
      view
    )
    const controller = new AbortController()
    const nativeConnection: CefStreamNativeConnection = { view, transport, controller }
    this.#streamConnections.set(Number(connection), nativeConnection)
    let selected = false
    const select = <T>(create: () => T): T => {
      if (selected || controller.signal.aborted)
        throw new BunlyError('INVALID_ARGUMENT', 'Native stream lane endpoint already selected')
      selected = true
      return create()
    }
    const shared = (options: Omit<BinaryStreamOptions, 'budget' | 'owner' | 'signal'> = {}) => {
      if (options.maxChunkBytes !== undefined && options.maxChunkBytes > STREAM_CHUNK_BYTES)
        throw new TypeError('Native CEF stream chunks cannot exceed 16 KiB')
      return {
        ...options,
        budget: service.budget,
        owner: view,
        signal: controller.signal,
      }
    }
    const exposed: CefStreamConnection = Object.freeze({
      view,
      signal: controller.signal,
      sender: (options?: Omit<BinaryStreamOptions, 'budget' | 'owner' | 'signal'>) =>
        select(() => new BinaryStreamSender(transport, shared(options))),
      receiver: (
        sinks: Readonly<Record<string, BinaryStreamSink>>,
        options?: Omit<BinaryStreamOptions, 'budget' | 'owner' | 'signal'>
      ) => select(() => new BinaryStreamReceiver(transport, shared(options), sinks)),
    })
    const failed = () => {
      if (this.#streamConnections.get(Number(connection)) !== nativeConnection) return
      this.#streamConnectionFailures++
      this.#streamConnections.delete(Number(connection))
      controller.abort(new Error('Native stream callback failed'))
      transport.end(true)
    }
    try {
      // Endpoint selection is synchronous; later asynchronous setup failures
      // still retire this exact incarnation, never a replacement connection.
      const initialized = service.connect(exposed)
      void Promise.resolve(initialized).catch(failed)
      if (!selected) throw new Error('Native stream callback did not select an endpoint')
    } catch {
      failed()
    }
  }
  #streamPacket(
    view: ViewHandle | undefined,
    data: Record<string, unknown> | null | undefined
  ): void {
    if (
      !data ||
      !Number.isSafeInteger(data['connection']) ||
      !Number.isSafeInteger(data['sequence'])
    )
      throw new Error('Invalid native stream packet metadata')
    const connection = this.#streamConnections.get(Number(data['connection']))
    if (!connection) return
    if (connection.view !== view) throw new Error('Native stream view mismatch')
    if (
      data['context'] !== connection.transport.identity.context ||
      data['generation'] !== connection.transport.identity.generation ||
      Number(data['sequence']) < 1
    )
      throw new Error('Native stream incarnation mismatch')
    const packet = unhex(data['packet'])
    if (data['copiedBytes'] !== packet.byteLength)
      throw new Error('Native stream copy accounting mismatch')
    connection.transport.receive(packet, Number(data['sequence']))
  }
  #streamRevoked(
    view: ViewHandle | undefined,
    data: Record<string, unknown> | null | undefined
  ): void {
    if (!data || !Number.isSafeInteger(data['connection'])) return
    const connection = this.#streamConnections.get(Number(data['connection']))
    if (!connection) return
    if (connection.view !== view) throw new Error('Native stream view mismatch')
    if (
      data['context'] !== connection.transport.identity.context ||
      data['generation'] !== connection.transport.identity.generation
    )
      throw new Error('Native stream revocation incarnation mismatch')
    this.#streamConnections.delete(Number(data['connection']))
    this.#streamRetired.add(connection.view)
    connection.controller.abort(new Error('Native stream document revoked'))
    connection.transport.end(false)
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
    if (service.listener) {
      const binding = bindRpcAuthority(lease, resource.session)
      const current: CefRpcConnection = { view, transport, server: undefined, binding }
      this.#rpcConnections.set(Number(connection), current)
      transport.subscribe(
        (packet) => {
          let challenge: Uint8Array | undefined
          try {
            challenge = decodeNativeLoopbackConfirmation(packet)
            if (this.#rpcService !== service) throw new RpcError('REVOKED', 'RPC service retired')
            service.listener!.confirmNative(binding, challenge)
            this.#nativeConfirmations++
          } catch {
            this.#nativeConfirmationRejections++
            service.authority.revoke(view)
            transport.end(true)
          } finally {
            challenge?.fill(0)
          }
        },
        () => {
          this.#nativeControlClosed++
          service.authority.revoke(view)
          current.server?.close()
          if (this.#rpcConnections.get(Number(connection)) === current)
            this.#rpcConnections.delete(Number(connection))
        }
      )
      let offer: Uint8Array
      const handoff = service.listener.provision(binding)
      try {
        offer = encodeNativeLoopbackHandoff(handoff)
      } finally {
        handoff.credential.fill(0)
      }
      void transport
        .send(offer)
        .catch((error: unknown) => {
          this.#nativeOfferFailure =
            error instanceof Error ? error.message.slice(0, 160) : 'Native offer failed'
          service.authority.revoke(view)
          transport.end(true)
        })
        .finally(() => offer.fill(0))
      return
    }
    const server = new RpcServer(
      service.schema,
      service.handlers,
      lease,
      fragmentedRpcTransport(transport, this.#rpcFragments),
      service.options
    )
    this.#rpcConnections.set(Number(connection), { view, transport, server, binding: undefined })
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
    // The native binding is shared. Its revocation must also stop stream-only
    // owners; an RPC server need not have subscribed in this document.
    this.#streamRevoked(view, data)
    const connection = this.#rpcConnections.get(Number(data['connection']))
    if (!connection) return
    if (connection.view !== view) throw new Error('Native RPC view mismatch')
    if (
      data['context'] !== connection.transport.identity.context ||
      data['generation'] !== connection.transport.identity.generation
    )
      throw new Error('Native RPC revocation incarnation mismatch')
    this.#nativeRevocations++
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

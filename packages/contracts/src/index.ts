/** Engine-independent contracts. This package must remain browser-safe. */
export * from './core.ts'
export * from './windows.ts'
export * from './profiles.ts'
export * from './rpc-websocket-wire.ts'
export * from './network-policy.ts'
export * from './view-composition.ts'
import type { ViewLayoutMode, ViewLayer, ViewPresentationOptions } from './view-composition.ts'
export type {
  PersistentSessionResetOptions,
  PersistentSessionResetResult,
} from './session-reset.ts'
import type { SessionNetworkPolicy } from './network-policy.ts'
import type { Bounds, WindowEvent, WindowState } from './windows.ts'
import { BunlyError, CONTRACT_VERSION } from './core.ts'
import { PROFILE_CAPABILITY_VERSION } from './profiles.ts'
import type { BackendName, Capability } from './core.ts'
export interface BackendDescriptor {
  readonly name: BackendName
  readonly version: string
  readonly contractVersion: typeof CONTRACT_VERSION
  /** The capability metadata version the backend was written against. */
  readonly capabilityVersion: number
  readonly capabilities: readonly Capability[]
}
declare const handleBrand: unique symbol
export type ResourceKind = 'window' | 'view' | 'session'
/** Opaque in-process handle. Its public ID is diagnostic data, never authority. */
export interface Handle<K extends ResourceKind> {
  readonly id: string
  readonly kind: K
  readonly [handleBrand]: K
}
export type WindowHandle = Handle<'window'>
export type ViewHandle = Handle<'view'>
export type SessionHandle = Handle<'session'>
export interface WindowOptions {
  readonly title: string
  readonly bounds: Bounds
  /** Default stack retains the automatic equal-height layout. Manual placement is opt-in. */
  readonly viewLayout?: ViewLayoutMode
}
export interface SessionOptions {
  readonly persistence: 'ephemeral' | 'persistent'
  /** Opt-in requires a configured, verified OS provider; absence keeps persistent cookies disabled. */
  readonly persistentCookies?: 'os-protected'
  readonly partition: string
  /** Immutable per-session navigation/resource origins; absent means local content only. */
  readonly network?: SessionNetworkPolicy
  /**
   * Absolute application-owned profile root configured for the native host.
   * Required for persistent sessions and forbidden for ephemeral sessions.
   */
  readonly persistentRoot?: string
}
export type ViewTrust =
  | { readonly kind: 'remote' }
  | { readonly kind: 'application'; readonly origin: string }
export interface ViewOptions {
  readonly window: WindowHandle
  readonly session: SessionHandle
  readonly url: string
  readonly trust: ViewTrust
  /** Required in manual windows and forbidden in default stack windows. */
  readonly presentation?: ViewPresentationOptions
  /** Overlays are application-owned surfaces, created after all content panes. */
  readonly layer?: ViewLayer
}
export interface ViewState {
  readonly url: string
  readonly documentId: string
  readonly trust: ViewTrust
}
export interface OperationOptions {
  readonly signal?: AbortSignal
}
export type InputAction =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'pointer'
      readonly x: number
      readonly y: number
      readonly button: 'left' | 'right'
    }
export interface Cookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: 'unspecified' | 'none' | 'lax' | 'strict'
  /** Unix milliseconds. Omitted for a non-persistent session cookie. */
  readonly expires?: number
}
export interface CookieInput {
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: Cookie['sameSite']
  /** Unix milliseconds. Omit to create a non-persistent session cookie. */
  readonly expires?: number
}
export interface CookieQuery {
  /** Limit enumeration to cookies visible to this absolute HTTP(S) URL. */
  readonly url?: string
}
export interface CookieDelete {
  /** Omit both fields to delete every cookie in the session. */
  readonly url?: string
  readonly name?: string
}
export interface SessionClearOptions {
  readonly cookies?: boolean
  readonly cache?: boolean
  /** Requires the separately advertised session.storage-clear capability. */
  readonly storage?: boolean
}
export interface SessionClearResult {
  readonly cookiesDeleted: number
  readonly cacheCleared: boolean
  readonly storageCleared: boolean
}
export interface DownloadRequest {
  readonly url: string
  readonly suggestedName?: string
}
export interface DownloadResult {
  readonly status: 'completed' | 'cancelled'
  readonly bytesWritten: number
}
export type RuntimeEvent =
  | { readonly type: 'created' | 'disposed'; readonly resource: Handle<ResourceKind> }
  | { readonly type: 'navigated'; readonly resource: ViewHandle; readonly state: ViewState }
  | {
      readonly type: 'window-state-changed'
      readonly resource: WindowHandle
      readonly state: WindowState
    }
  | {
      readonly type: 'window-bounds-changed'
      readonly resource: WindowHandle
      readonly bounds: Bounds
    }
  | {
      readonly type: 'window-fullscreen-transition'
      readonly resource: WindowHandle
      readonly completed: boolean
      readonly state: WindowState
    }
export interface Diagnostics {
  readonly windows: number
  readonly views: number
  readonly sessions: number
  readonly listeners: number
  readonly listenerErrors: number
}
export interface BrowserBackend {
  readonly descriptor: BackendDescriptor
  createSession(options: SessionOptions): Promise<SessionHandle>
  createWindow(options: WindowOptions): Promise<WindowHandle>
  createView(options: ViewOptions): Promise<ViewHandle>
  navigate(view: ViewHandle, url: string, options?: OperationOptions): Promise<ViewState>
  state(view: ViewHandle): ViewState
  /** Return the opaque session that owns this exact live view handle. */
  session(view: ViewHandle): SessionHandle
  windowState(window: WindowHandle, options?: OperationOptions): Promise<WindowState>
  minimizeWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState>
  restoreWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState>
  activateWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState>
  maximizeWindow(window: WindowHandle, options?: OperationOptions): Promise<WindowState>
  setWindowFullscreen(
    window: WindowHandle,
    fullscreen: boolean,
    options?: OperationOptions
  ): Promise<WindowState>
  showWindow(window: WindowHandle, visible: boolean, options?: OperationOptions): Promise<void>
  resizeWindow(
    window: WindowHandle,
    width: number,
    height: number,
    options?: OperationOptions
  ): Promise<void>
  windowBounds(window: WindowHandle, options?: OperationOptions): Promise<Bounds>
  setWindowBounds(window: WindowHandle, bounds: Bounds, options?: OperationOptions): Promise<Bounds>
  onWindowEvent(
    window: WindowHandle,
    listener: (event: WindowEvent) => void,
    options?: OperationOptions
  ): () => void
  closeWindow(window: WindowHandle): Promise<void>
  disposeView(view: ViewHandle): Promise<void>
  disposeSession(session: SessionHandle): Promise<void>
  snapshot(view: ViewHandle, options?: OperationOptions): Promise<Uint8Array>
  evaluate(view: ViewHandle, script: string, options?: OperationOptions): Promise<unknown>
  input(view: ViewHandle, action: InputAction, options?: OperationOptions): Promise<void>
  cookies(session: SessionHandle, query?: CookieQuery): Promise<readonly Cookie[]>
  setCookie(session: SessionHandle, url: string, cookie: CookieInput): Promise<void>
  deleteCookies(session: SessionHandle, filter?: CookieDelete): Promise<number>
  clearSession(session: SessionHandle, options: SessionClearOptions): Promise<SessionClearResult>
  flushSession(session: SessionHandle): Promise<void>
  requestPermission(view: ViewHandle, permission: string): Promise<'granted' | 'denied'>
  download(
    view: ViewHandle,
    request: DownloadRequest,
    options?: OperationOptions
  ): Promise<DownloadResult>
  extension(view: ViewHandle, name: `${string}:${string}`, input: unknown): Promise<unknown>
  onEvent(listener: (event: RuntimeEvent) => void): () => void
  diagnostics(): Diagnostics
  dispose(): Promise<void>
}
export function requireCapability(descriptor: BackendDescriptor, capability: Capability): void {
  if (descriptor.contractVersion !== CONTRACT_VERSION) {
    throw new BunlyError(
      'VERSION_MISMATCH',
      `Expected contract ${CONTRACT_VERSION}, got ${descriptor.contractVersion}`
    )
  }
  if (descriptor.capabilityVersion !== PROFILE_CAPABILITY_VERSION) {
    throw new BunlyError(
      'VERSION_MISMATCH',
      `Expected capability metadata ${PROFILE_CAPABILITY_VERSION}, got ${descriptor.capabilityVersion}`
    )
  }
  if (!descriptor.capabilities.includes(capability)) {
    throw new BunlyError(
      'UNSUPPORTED_CAPABILITY',
      `${descriptor.name} does not implement ${capability}`
    )
  }
}
export function validateBounds(value: Bounds): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BunlyError('INVALID_ARGUMENT', 'Bounds must be an object')
  const numbers = [value.x, value.y, value.width, value.height]
  if (
    !numbers.every(Number.isSafeInteger) ||
    Math.abs(value.x) > 32768 ||
    Math.abs(value.y) > 32768 ||
    value.width <= 0 ||
    value.height <= 0 ||
    value.width > 32768 ||
    value.height > 32768
  ) {
    throw new BunlyError(
      'INVALID_ARGUMENT',
      'Bounds require integer coordinates in [-32768, 32768] and dimensions in [1, 32768]'
    )
  }
}
/** URL validation is not an origin grant. Native adapters must validate redirects too. */
export function normalizeUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BunlyError('INVALID_ARGUMENT', 'Expected an absolute URL')
  }
  if (
    !['app:', 'https:', 'http:', 'about:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === 'about:' && url.href !== 'about:blank') ||
    (url.protocol === 'app:' && (!url.hostname || url.port))
  ) {
    throw new BunlyError('INVALID_ARGUMENT', 'Unsupported or credential-bearing URL')
  }
  return url.href
}
/** Custom app origins are explicit; URL.origin would return the opaque string "null". */
export function originOf(value: string): string {
  const url = new URL(normalizeUrl(value))
  return url.protocol === 'app:' ? `app://${url.host}` : url.origin
}

export {
  RPC_VERSION,
  RPC_ERROR_CODES,
  DEFAULT_RPC_LIMITS,
  RpcError,
  defineRpc,
  procedure,
} from './rpc.ts'
export type {
  RpcValue,
  JsonValue,
  Parser,
  RpcProcedure,
  RpcSchema,
  RpcInput,
  RpcOutput,
  RpcErrorCode,
  RpcLimits,
  RpcScheduler,
  RpcTransport,
  RpcCallOptions,
} from './rpc.ts'

export { BinaryStreamSender, BinaryStreamReceiver } from './streams.ts'
export type {
  BinaryStreamOptions,
  BinaryStreamWriter,
  BinaryStreamSink,
  StreamConsumerContext,
  StreamOutcome,
} from './streams.ts'
export { StreamBudget } from './stream-budget.ts'
export type { StreamBudgetLimits } from './stream-budget.ts'
export {
  STREAM_VERSION,
  STREAM_CHUNK_BYTES,
  StreamError,
  StreamFramer,
  writeStreamPacket,
} from './stream-wire.ts'
export type { StreamErrorCode } from './stream-wire.ts'

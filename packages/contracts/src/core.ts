/** Engine-independent contract primitives. This package must remain browser-safe. */
export const CONTRACT_VERSION = 3 as const
export const CAPABILITIES = [
  'window.lifecycle',
  'window.state',
  'window.geometry',
  'clipboard.text',
  'app.lifecycle',
  'view.navigate',
  'view.composition',
  'session.ephemeral',
  'session.persistent',
  'session.cookies',
  'session.protected-cookies',
  'session.cache',
  'session.flush',
  'session.storage-clear',
  'session.network-policy',
  'permission.request',
  'download.manage',
  'view.snapshot',
  'view.evaluate',
  'view.input',
  'view.input.synthetic',
  'view.observe-dom',
  'view.observe-accessibility',
  'backend.extensions',
] as const
export type Capability = (typeof CAPABILITIES)[number]
export type BackendName = 'mock' | 'cef' | 'webview2' | 'wkwebview' | 'webkitgtk'
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_HANDLE'
  | 'DISPOSED'
  | 'RESOURCE_IN_USE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'VERSION_MISMATCH'
  | 'PERMISSION_DENIED'
export class BunlyError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'BunlyError'
  }
}

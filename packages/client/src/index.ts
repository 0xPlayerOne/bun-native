export {
  CONTRACT_VERSION,
  CAPABILITIES,
  BunlyError,
  requireCapability,
} from '../../contracts/src/index.ts'
export type {
  BackendDescriptor,
  Bounds,
  WindowState,
  WindowEvent,
  ViewLayoutMode,
  ViewLayer,
  ViewPresentationOptions,
  ViewPresentation,
  ViewPresentationState,
  Capability,
  ViewState,
  InputAction,
  Cookie,
  CookieInput,
  CookieQuery,
  CookieDelete,
  SessionClearOptions,
  SessionClearResult,
  DownloadRequest,
  DownloadResult,
  OperationOptions,
} from '../../contracts/src/index.ts'

/** Descriptor validation is feature discovery, NOT native authorization. */
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  PROFILE_CAPABILITY_VERSION,
  BunlyError,
} from '../../contracts/src/index.ts'
import type { BackendDescriptor, BackendName, Capability } from '../../contracts/src/index.ts'
export function readDescriptor(value: unknown): BackendDescriptor {
  if (typeof value !== 'object' || value === null)
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid backend descriptor')
  const v = value as Record<string, unknown>
  if (v['contractVersion'] !== CONTRACT_VERSION)
    throw new BunlyError('VERSION_MISMATCH', 'Unsupported backend contract')
  if (v['capabilityVersion'] !== PROFILE_CAPABILITY_VERSION)
    throw new BunlyError('VERSION_MISMATCH', 'Unsupported capability metadata version')
  const names: BackendName[] = ['mock', 'cef', 'webview2', 'wkwebview', 'webkitgtk']
  if (
    !names.includes(v['name'] as BackendName) ||
    typeof v['version'] !== 'string' ||
    !Array.isArray(v['capabilities']) ||
    !v['capabilities'].every((c: unknown) => CAPABILITIES.includes(c as Capability)) ||
    new Set(v['capabilities']).size !== v['capabilities'].length
  ) {
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid backend descriptor')
  }
  return Object.freeze({
    name: v['name'] as BackendName,
    version: v['version'],
    contractVersion: CONTRACT_VERSION,
    capabilityVersion: PROFILE_CAPABILITY_VERSION,
    capabilities: Object.freeze([...v['capabilities']] as Capability[]),
  })
}

export { RpcClient } from './rpc.ts'
export type { RpcClientOptions } from './rpc.ts'
export { rpcMessagePort } from './rpc-port.ts'
export { RpcLoopbackTransport } from './rpc-loopback.ts'
export type { RpcLoopbackClientOptions } from './rpc-loopback.ts'
export { cefRpcTransport, waitForCefRpcTransport } from './cef-rpc.ts'
export { cefStreamTransport, waitForCefStreamTransport } from './cef-streams.ts'
export { waitForCefLoopbackTransport } from './cef-loopback.ts'

export {
  BinaryStreamSender,
  BinaryStreamReceiver,
  StreamBudget,
  StreamError,
} from '../../contracts/src/index.ts'
export type {
  BinaryStreamOptions,
  BinaryStreamWriter,
  BinaryStreamSink,
  StreamConsumerContext,
  StreamOutcome,
  StreamBudgetLimits,
  StreamErrorCode,
} from '../../contracts/src/index.ts'

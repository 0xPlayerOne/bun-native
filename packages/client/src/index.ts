export {
  CONTRACT_VERSION, CAPABILITIES, BunlyError, requireCapability,
} from '../../contracts/src/index.ts';
export type {
  BackendDescriptor, Capability, ViewState, InputAction, Cookie,
  DownloadRequest, DownloadResult, OperationOptions,
} from '../../contracts/src/index.ts';

/** Descriptor validation is feature discovery, NOT native authorization. */
import { CAPABILITIES, CONTRACT_VERSION, BunlyError } from '../../contracts/src/index.ts';
import type { BackendDescriptor, BackendName, Capability } from '../../contracts/src/index.ts';
export function readDescriptor(value: unknown): BackendDescriptor {
  if (typeof value !== 'object' || value === null) throw new BunlyError('INVALID_ARGUMENT', 'Invalid backend descriptor');
  const v = value as Record<string, unknown>;
  if (v['contractVersion'] !== CONTRACT_VERSION) throw new BunlyError('VERSION_MISMATCH', 'Unsupported backend contract');
  const names: BackendName[] = ['mock', 'cef', 'webview2', 'wkwebview', 'webkitgtk'];
  if (!names.includes(v['name'] as BackendName) || typeof v['version'] !== 'string' || !Array.isArray(v['capabilities']) ||
      !v['capabilities'].every((c: unknown) => CAPABILITIES.includes(c as Capability)) ||
      new Set(v['capabilities']).size !== v['capabilities'].length) {
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid backend descriptor');
  }
  return Object.freeze({ name: v['name'] as BackendName, version: v['version'], contractVersion: CONTRACT_VERSION,
    capabilities: Object.freeze([...v['capabilities']] as Capability[]) });
}

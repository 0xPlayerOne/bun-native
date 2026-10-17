import type { BrowserBackend, ViewHandle } from '../../contracts/src/index.ts';
import { originOf } from '../../contracts/src/index.ts';
import { RpcError, validProcedure } from '../../contracts/src/rpc.ts';
export interface NativeRpcFrame {
  readonly frameId: string;
  readonly documentId: string;
  readonly mainFrame: boolean;
}
export interface RpcIdentity {
  readonly viewId: string;
  readonly frameId: string;
  readonly documentId: string;
  readonly origin: string;
  readonly generation: number;
}
declare const leaseBrand: unique symbol;
/** Opaque runtime-only capability. It is never serialized, logged, or sent to a page. */
export interface RpcLease { readonly [leaseBrand]: true }
interface LeaseState {
  readonly identity: RpcIdentity;
  readonly controller: AbortController;
  readonly capabilities: ReadonlySet<string>;
  readonly current: () => boolean;
  claimed: boolean;
  readonly acquire: () => () => void;
}
const leases = new WeakMap<object, LeaseState>();
function denied(): never { throw new RpcError('FORBIDDEN', 'RPC authority is not valid for this connection'); }
export interface RpcAuthorityGuard {
  readonly identity: RpcIdentity;
  readonly signal: AbortSignal;
  check(capability: string): void;
  acquire(): () => void;
}
/** Internal server boundary; shape-compatible objects and reused leases are rejected. */
export function claimRpcAuthority(lease: RpcLease): RpcAuthorityGuard {
  const state = leases.get(lease);
  if (!state || state.claimed || state.controller.signal.aborted || !state.current()) return denied();
  state.claimed = true;
  return Object.freeze({
    identity: state.identity, signal: state.controller.signal,
    acquire() {
      if (state.controller.signal.aborted || !state.current()) throw new RpcError('REVOKED', 'RPC document authority was revoked');
      return state.acquire();
    },
    check(capability: string) {
      if (state.controller.signal.aborted || !state.current()) throw new RpcError('REVOKED', 'RPC document authority was revoked');
      if (!state.capabilities.has(capability)) return denied();
    },
  });
}
export interface RpcAuthorityOptions { readonly maxExecutions?: number; readonly maxExecutionsPerView?: number }
/**
 * Host policy, not a renderer authenticator. The adapter must attest the frame
 * and deliver its transport privately. No URL token or loopback listener exists here.
 */
export class RpcViewAuthority {
  readonly #current = new Map<ViewHandle, LeaseState>();
  readonly #executions = new Map<ViewHandle, number>();
  readonly #maxExecutions: number;
  readonly #maxPerView: number;
  #executing = 0;
  readonly #origins: ReadonlySet<string>;
  readonly #off: () => void;
  #generation = 0;
  #disposed = false;
  #revoking = false;
  constructor(readonly backend: BrowserBackend, origins: readonly string[], options: RpcAuthorityOptions = {}) {
    this.#maxExecutions = options.maxExecutions ?? 128; this.#maxPerView = options.maxExecutionsPerView ?? 64;
    if (![this.#maxExecutions, this.#maxPerView].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 4096)) throw new TypeError('Invalid RPC authority execution budget');
    if (!origins.length || origins.length > 32) throw new TypeError('Supply exact approved application origins');
    for (const value of origins) if (originOf(value) !== value || value === 'null') throw new TypeError('RPC origins must be exact and non-opaque');
    this.#origins = new Set(origins);
    this.#off = backend.onEvent(event => {
      if (event.resource.kind === 'view' && (event.type === 'navigated' || event.type === 'disposed')) this.revoke(event.resource as ViewHandle);
    });
  }
  issue(view: ViewHandle, frame: NativeRpcFrame, capabilities: readonly string[]): RpcLease {
    if (this.#disposed || this.#revoking) throw new RpcError('REVOKED', 'RPC authority manager disposed');
    const document = this.backend.state(view); // Authoritative registry rejects copied/cross-owner handles.
    if (frame.mainFrame !== true || !frame.frameId || frame.frameId.length > 256 || frame.frameId.includes('\0') ||
        frame.documentId !== document.documentId || document.trust.kind !== 'application' ||
        !this.#origins.has(document.trust.origin) || originOf(document.url) !== document.trust.origin) return denied();
    if (capabilities.length > 256 || capabilities.some(c => !validProcedure(c)) || new Set(capabilities).size !== capabilities.length) throw new TypeError('Invalid RPC capabilities');
    if ((!this.#current.has(view) && this.#current.size >= 128) || this.#generation >= Number.MAX_SAFE_INTEGER) throw new RpcError('OVERLOADED', 'RPC authority capacity exceeded');
    this.revoke(view);
    // Abort listeners may dispose this manager/view before replacement completes.
    if (this.#disposed) throw new RpcError('REVOKED', 'RPC authority manager disposed');
    const latest = this.backend.state(view);
    if (latest.documentId !== document.documentId || latest.trust.kind !== 'application' ||
        latest.trust.origin !== document.trust.origin || originOf(latest.url) !== document.trust.origin) return denied();
    const identity: RpcIdentity = Object.freeze({ viewId: view.id, frameId: frame.frameId, documentId: frame.documentId, origin: document.trust.origin, generation: ++this.#generation });
    const state: LeaseState = {
      identity, controller: new AbortController(), capabilities: new Set(capabilities), claimed: false,
      acquire: () => {
        const active = this.#executions.get(view) ?? 0;
        if (this.#executing >= this.#maxExecutions || active >= this.#maxPerView) throw new RpcError('OVERLOADED', 'RPC host execution budget exhausted');
        this.#executing++; this.#executions.set(view, active + 1);
        let released = false;
        return () => {
          if (released) return; released = true; this.#executing--;
          const remaining = (this.#executions.get(view) ?? 1) - 1;
          if (remaining) this.#executions.set(view, remaining); else this.#executions.delete(view);
        };
      },
      current: () => {
        if (this.#disposed || this.#current.get(view) !== state) return false;
        try {
          const latest = this.backend.state(view);
          return latest.documentId === identity.documentId && latest.trust.kind === 'application' &&
            latest.trust.origin === identity.origin && originOf(latest.url) === identity.origin;
        } catch { return false; }
      },
    };
    this.#current.set(view, state);
    const lease = Object.freeze({}) as RpcLease; leases.set(lease, state); return lease;
  }
  /** Call synchronously at native navigation-start/frame replacement, not after commit. */
  revoke(view: ViewHandle): void {
    const state = this.#current.get(view); if (!state) return;
    this.#current.delete(view);
    const wasRevoking = this.#revoking; this.#revoking = true;
    try { state.controller.abort(new RpcError('REVOKED', 'RPC document authority was revoked')); }
    finally { this.#revoking = wasRevoking; }
  }
  /** Reload may keep the view alive, but the old service generation loses all grants. */
  revokeAll(): void {
    // Remove every grant before dispatching abort listeners. A listener may call
    // dispose() while revoke(view) is already active; remaining views still need
    // their abort notification, not just a failed current() check on the next call.
    const states = Array.from(this.#current.values()); this.#current.clear();
    const wasRevoking = this.#revoking; this.#revoking = true;
    try { for (const state of states) state.controller.abort(new RpcError('REVOKED', 'RPC document authority was revoked')); }
    finally { this.#revoking = wasRevoking; }
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#off(); this.revokeAll(); }
  diagnostics(): Readonly<{ documents: number; executing: number; disposed: boolean }> { return { documents: this.#current.size, executing: this.#executing, disposed: this.#disposed }; }
}

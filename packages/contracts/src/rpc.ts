/** Browser-safe application RPC. Native control and bulk streams are separate protocols. */
export const RPC_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type RpcValue = JsonValue | Uint8Array;
export type Parser<T> = (value: unknown) => T;
export interface RpcProcedure<I, O> { readonly input: Parser<I>; readonly output: Parser<O> }
export type RpcSchema = Readonly<Record<string, RpcProcedure<unknown, unknown>>>;
export type RpcInput<P> = P extends RpcProcedure<infer I, unknown> ? I : never;
export type RpcOutput<P> = P extends RpcProcedure<unknown, infer O> ? O : never;
export function procedure<I, O>(input: Parser<I>, output: Parser<O>): RpcProcedure<I, O> {
  if (typeof input !== 'function' || typeof output !== 'function') throw new TypeError('RPC requires input and output parsers');
  return Object.freeze({ input, output });
}
export function validProcedure(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(name) && !['constructor', 'prototype', '__proto__'].includes(name);
}
export function defineRpc<const S extends RpcSchema>(schema: S): S {
  const copy: Record<string, RpcProcedure<unknown, unknown>> = Object.create(null);
  const names = Object.keys(schema);
  if (!names.length || names.length > 256) throw new TypeError('RPC contract needs 1–256 procedures');
  for (const name of names) {
    if (!validProcedure(name)) throw new TypeError('Invalid RPC procedure name');
    const definition = schema[name]!;
    copy[name] = procedure(definition.input, definition.output);
  }
  return Object.freeze(copy) as S;
}
export const RPC_ERROR_CODES = [
  'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN', 'DEADLINE_EXCEEDED', 'CANCELLED',
  'OVERLOADED', 'INTERNAL', 'DISCONNECTED', 'PROTOCOL_ERROR', 'VERSION_MISMATCH', 'REVOKED',
] as const;
export type RpcErrorCode = typeof RPC_ERROR_CODES[number];
export class RpcError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) { super(message); this.name = 'RpcError'; this.code = code; }
}
export interface RpcLimits {
  readonly maxFrameBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxPending: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedFrames: number;
  readonly maxHandlers: number;
  readonly maxTimeoutMs: number;
  readonly sendTimeoutMs: number;
}
export const DEFAULT_RPC_LIMITS: Readonly<RpcLimits> = Object.freeze({
  maxFrameBytes: 1024 * 1024, maxMetadataBytes: 64 * 1024, maxPending: 64,
  maxQueuedBytes: 2 * 1024 * 1024, maxQueuedFrames: 128, maxHandlers: 64,
  maxTimeoutMs: 60_000, sendTimeoutMs: 5_000,
});
export function rpcLimits(input: Partial<RpcLimits> = {}): Readonly<RpcLimits> {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_RPC_LIMITS, key)) throw new TypeError('Unknown RPC limit');
  const value = { ...DEFAULT_RPC_LIMITS, ...input };
  for (const n of Object.values(value)) if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('RPC limits must be positive safe integers');
  if (value.maxFrameBytes < 512 || value.maxFrameBytes > 16 * 1024 * 1024 || value.maxMetadataBytes < 256 ||
      value.maxMetadataBytes > value.maxFrameBytes - 12 || value.maxQueuedBytes < value.maxFrameBytes ||
      value.maxQueuedBytes > 64 * 1024 * 1024 || value.maxQueuedFrames > 4096 || value.maxPending > 4096 ||
      value.maxHandlers > 4096 || value.maxTimeoutMs > 600_000 || value.sendTimeoutMs > 60_000) {
    throw new TypeError('RPC limits exceed the supported bounded profile');
  }
  return Object.freeze(value);
}
/** Monotonic time. Injected schedulers must never move backward or run timers inline. */
export interface RpcScheduler {
  now(): number;
  set(delayMs: number, callback: () => void): unknown;
  clear(timer: unknown): void;
}
export const rpcScheduler: RpcScheduler = Object.freeze({
  now: () => performance.now(),
  set: (delayMs: number, callback: () => void) => setTimeout(callback, delayMs),
  clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
/** One complete, owned packet per delivery; transport framing is not a byte stream. */
export interface RpcTransport {
  send(packet: Uint8Array): void | Promise<void>;
  subscribe(message: (packet: Uint8Array) => void, closed: () => void): () => void;
  close(): void;
}
export type RpcEnvelope =
  | { readonly type: 'request'; readonly id: number; readonly method: string; readonly timeoutMs: number; readonly value: unknown }
  | { readonly type: 'success'; readonly id: number; readonly value: unknown }
  | { readonly type: 'error'; readonly id: number; readonly code: RpcErrorCode; readonly message: string }
  | { readonly type: 'cancel'; readonly id: number };
export interface RpcCallOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }

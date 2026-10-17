import { RpcError, defineRpc, rpcLimits, rpcScheduler } from '../../contracts/src/rpc.ts';
import type { RpcSchema, RpcInput, RpcOutput, RpcLimits, RpcScheduler, RpcTransport, RpcCallOptions } from '../../contracts/src/rpc.ts';
import { encodeRpc, decodeRpc } from '../../contracts/src/rpc-wire.ts';
import { RpcChannel } from '../../contracts/src/rpc-channel.ts';
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RpcError) => void;
  readonly parse: (value: unknown) => unknown;
  readonly deadline: number;
  readonly delivery: AbortController;
  timer: unknown;
  sent: boolean;
  removeAbort: () => void;
}
export interface RpcClientOptions { readonly limits?: Partial<RpcLimits>; readonly scheduler?: RpcScheduler }
/** No reconnect or automatic retries: cancelled calls may already have side effects. */
export class RpcClient<S extends RpcSchema> {
  readonly #schema: S;
  readonly #limits: RpcLimits;
  readonly #clock: RpcScheduler;
  readonly #channel: RpcChannel;
  readonly #pending = new Map<number, Pending>();
  #sequence = 0;
  #closed: RpcError | undefined;
  readonly closed: Promise<RpcError>;
  constructor(schema: S, transport: RpcTransport, options: RpcClientOptions = {}) {
    this.#schema = defineRpc(schema); this.#limits = rpcLimits(options.limits); this.#clock = options.scheduler ?? rpcScheduler;
    this.#channel = new RpcChannel(transport, this.#limits, this.#clock, packet => this.#receive(packet), reason => {
      this.#closed = reason;
      for (const [id] of this.#pending) this.#settle(id, reason);
    });
    this.closed = this.#channel.closed; this.#channel.start();
  }
  call<K extends keyof S & string>(method: K, input: RpcInput<S[K]>, options: RpcCallOptions = {}): Promise<RpcOutput<S[K]>> {
    return this.#call(method, input, options) as Promise<RpcOutput<S[K]>>;
  }
  #call(method: string, input: unknown, options: RpcCallOptions): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (options.signal?.aborted) return Promise.reject(new RpcError('CANCELLED', 'RPC call cancelled'));
    const definition = Object.hasOwn(this.#schema, method) ? this.#schema[method] : undefined;
    if (!definition) return Promise.reject(new RpcError('NOT_FOUND', 'Unknown RPC procedure'));
    const timeoutMs = options.timeoutMs ?? Math.min(10_000, this.#limits.maxTimeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.#limits.maxTimeoutMs) return Promise.reject(new RpcError('BAD_REQUEST', 'Invalid RPC timeout'));
    if (this.#pending.size >= this.#limits.maxPending || this.#sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new RpcError('OVERLOADED', 'RPC pending request limit'));
    const id = ++this.#sequence, deadline = this.#clock.now() + timeoutMs;
    let packet: Uint8Array;
    try { packet = encodeRpc({ type: 'request', id, method, timeoutMs, value: definition.input(input) }, this.#limits); }
    catch { return Promise.reject(new RpcError('BAD_REQUEST', 'RPC input validation or serialization failed')); }
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, parse: definition.output, deadline, delivery: new AbortController(), timer: undefined, sent: false, removeAbort: () => {} };
      this.#pending.set(id, pending);
      const cancel = () => this.#cancel(id, new RpcError('CANCELLED', 'RPC call cancelled'));
      if (options.signal) { const signal = options.signal; signal.addEventListener('abort', cancel, { once: true }); pending.removeAbort = () => signal.removeEventListener('abort', cancel); }
      pending.timer = this.#clock.set(Math.max(0, deadline - this.#clock.now()), () => this.#cancel(id, new RpcError('DEADLINE_EXCEEDED', 'RPC deadline exceeded')));
      if (options.signal?.aborted) { cancel(); return; }
      void this.#channel.send(packet, pending.delivery.signal, () => {
        if (this.#clock.now() >= deadline) {
          const error = new RpcError('DEADLINE_EXCEEDED', 'RPC deadline exceeded'); this.#cancel(id, error); throw error;
        }
        pending.sent = true;
      }).catch(error => this.#settle(id, error instanceof RpcError ? error : new RpcError('DISCONNECTED', 'RPC delivery failed')));
    });
  }
  #settle(id: number, error?: RpcError, value?: unknown): void {
    const pending = this.#pending.get(id); if (!pending) return;
    this.#pending.delete(id); this.#clock.clear(pending.timer); pending.removeAbort();
    if (error) pending.reject(error); else pending.resolve(value);
  }
  #cancel(id: number, reason: RpcError): void {
    const pending = this.#pending.get(id); if (!pending) return;
    this.#settle(id, reason); pending.delivery.abort();
    if (pending.sent && !this.#closed) {
      void this.#channel.send(encodeRpc({ type: 'cancel', id }, this.#limits)).catch(() => this.#channel.close(new RpcError('DISCONNECTED', 'RPC cancellation could not be delivered')));
    }
  }
  #receive(packet: Uint8Array): void {
    const message = decodeRpc(packet, this.#limits);
    if (message.type !== 'success' && message.type !== 'error') throw new RpcError('PROTOCOL_ERROR', 'Expected an RPC reply');
    if (message.id > this.#sequence) throw new RpcError('PROTOCOL_ERROR', 'Unsolicited RPC response');
    // Monotonic IDs avoid an unbounded tombstone set. Never reuse a settled ID.
    const pending = this.#pending.get(message.id); if (!pending) return;
    if (this.#clock.now() >= pending.deadline) { this.#cancel(message.id, new RpcError('DEADLINE_EXCEEDED', 'RPC deadline exceeded')); return; }
    if (message.type === 'error') { this.#settle(message.id, new RpcError(message.code, message.message)); return; }
    let output: unknown;
    try { output = pending.parse(message.value); }
    catch { throw new RpcError('PROTOCOL_ERROR', 'RPC response validation failed'); }
    // Parsers are trusted code, but can spend time or trigger cancellation.
    if (this.#pending.get(message.id) !== pending) return;
    if (this.#clock.now() >= pending.deadline) { this.#cancel(message.id, new RpcError('DEADLINE_EXCEEDED', 'RPC deadline exceeded')); return; }
    this.#settle(message.id, undefined, output);
  }
  close(): void { this.#channel.close(); }
  diagnostics(): Readonly<{ pending: number; queuedBytes: number; queuedFrames: number; closed: boolean }> {
    return { pending: this.#pending.size, ...this.#channel.diagnostics() };
  }
}

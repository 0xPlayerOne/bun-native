import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
export interface NativeEvent { readonly v: 1; readonly event: string; readonly target?: number; readonly data?: Record<string, unknown>; readonly abi?: number; readonly cef?: string }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; removeAbort(): void };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native frame is not an object'); return value as Record<string, unknown>; }
/** Private inherited pipes, not renderer IPC. Application code never writes protocol frames itself. */
export class NativeTransport {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: NativeEvent) => void>();
  readonly #abandoned = new Set<number>();
  #next = 0;
  #closed = false;
  #queuedBytes = 0;
  #ready = false;
  #resolveReady!: (event: NativeEvent) => void;
  #rejectReady!: (error: Error) => void;
  #resolveClosed!: () => void;
  readonly ready: Promise<NativeEvent>;
  readonly closed: Promise<void>;
  constructor(input: Readable, output: Writable) {
    this.#input = input; this.#output = output;
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.closed = new Promise(resolve => { this.#resolveClosed = resolve; });
    void this.ready.catch(() => {});
    output.on('error', error => this.fail(error));
    void this.#read();
  }
  onEvent(listener: (event: NativeEvent) => void): () => void { if (this.#closed) throw new Error('Native transport closed'); this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  async call(operation: string, args: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 10000): Promise<unknown> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (this.#closed || !this.#ready) throw new Error('Native transport is not ready');
    if (this.#pending.size >= 128 || this.#abandoned.size >= 128) throw new Error('Native request capacity exceeded');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000 || !/^[a-z][a-z.]{0,63}$/.test(operation)) throw new Error('Invalid native request');
    const id = ++this.#next;
    const bytes = Buffer.from(JSON.stringify({ v: 1, id, op: operation, args }) + '\n');
    if (bytes.length > 65536 || this.#queuedBytes + bytes.length > 1024 * 1024) throw new Error('Native output capacity exceeded');
    return new Promise((resolve, reject) => {
      const abandon = (error: Error) => {
        const pending = this.#pending.get(id); if (!pending) return;
        this.#pending.delete(id); clearTimeout(pending.timer); pending.removeAbort(); this.#abandoned.add(id); reject(error);
      };
      const abort = () => abandon(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => abandon(new Error(`Native request deadline: ${operation}`)), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, removeAbort: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      this.#queuedBytes += bytes.length;
      this.#output.write(bytes, error => { this.#queuedBytes -= bytes.length; if (error) this.fail(error); });
    });
  }
  diagnostics() { return { requests: this.#pending.size, abandoned: this.#abandoned.size, queuedBytes: this.#queuedBytes, listeners: this.#listeners.size, closed: this.#closed }; }
  fail(reason: unknown): void {
    if (this.#closed) return; this.#closed = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.removeAbort(); pending.reject(error); }
    this.#pending.clear(); this.#abandoned.clear(); this.#listeners.clear(); this.#resolveClosed();
  }
  async #read(): Promise<void> {
    const decoder = new StringDecoder('utf8'); let buffered = '';
    try {
      for await (const chunk of this.#input) {
        if (this.#closed) break;
        buffered += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        let processed = 0;
        for (;;) {
          const end = buffered.indexOf('\n'); if (end < 0) break;
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (Buffer.byteLength(line) > 65535) throw new Error('Native input frame exceeds limit');
          this.#receive(object(JSON.parse(line)));
          if (++processed % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (Buffer.byteLength(buffered) > 65536) throw new Error('Unterminated native frame exceeds limit');
      }
      if (!this.#closed) this.fail(new Error('Native host disconnected'));
    } catch (error) { this.fail(error); }
  }
  #receive(frame: Record<string, unknown>): void {
    if (frame['v'] !== 1) throw new Error('Native protocol version mismatch');
    if (typeof frame['event'] === 'string') {
      if (frame['event'].length > 64 || (frame['target'] !== undefined && (!Number.isSafeInteger(frame['target']) || Number(frame['target']) <= 0))) throw new Error('Invalid native event');
      const event = frame as unknown as NativeEvent;
      if (event.event === 'ready') { if (this.#ready || event.abi !== 1) throw new Error('Native readiness/ABI mismatch'); this.#ready = true; this.#resolveReady(event); }
      for (const listener of this.#listeners) { try { listener(event); } catch { /* Diagnostics listeners cannot disrupt protocol progress. */ } }
      if (event.event === 'shutdown') this.fail(new Error('Native host shut down'));
      return;
    }
    const id = frame['id'];
    if (!Number.isSafeInteger(id) || Number(id) <= 0 || Number(id) > this.#next || typeof frame['ok'] !== 'boolean') throw new Error('Invalid native response');
    if (this.#abandoned.delete(Number(id))) return;
    const pending = this.#pending.get(Number(id)); if (!pending) throw new Error('Unexpected or duplicate native response');
    this.#pending.delete(Number(id)); clearTimeout(pending.timer); pending.removeAbort();
    if (frame['ok']) pending.resolve(frame['value']);
    else pending.reject(new Error(typeof frame['error'] === 'string' ? frame['error'] : 'Native operation failed'));
  }
}

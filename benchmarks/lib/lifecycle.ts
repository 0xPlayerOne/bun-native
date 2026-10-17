/** Deterministic fault fixtures; never presented as real renderer/IPC implementation. */
export type ResourceType = 'handle' | 'listener' | 'request' | 'process' | 'descriptor';
export class Ledger {
  #live = new Map<symbol, { type: ResourceType; owner: string }>();
  #queuedBytes = 0;
  readonly limit: number;
  constructor(limit = 65536) { if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid queue limit'); this.limit = limit; }
  acquire(type: ResourceType, owner: string): { release(): void; assertLive(): void } {
    const token = Symbol(type); this.#live.set(token, { type, owner });
    return { release: () => { this.#live.delete(token); }, assertLive: () => { if (!this.#live.has(token)) throw new Error('STALE_HANDLE'); } };
  }
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#queuedBytes + bytes > this.limit) throw new Error('QUEUE_LIMIT');
    this.#queuedBytes += bytes; let released = false;
    return () => { if (!released) { released = true; this.#queuedBytes -= bytes; } };
  }
  snapshot() {
    const counts: Record<ResourceType, number> = { handle: 0, listener: 0, request: 0, process: 0, descriptor: 0 };
    for (const item of this.#live.values()) counts[item.type]++;
    return { ...counts, queuedBytes: this.#queuedBytes };
  }
  assertClean(): void { if (this.#live.size || this.#queuedBytes) throw new Error(`RESOURCE_LEAK ${JSON.stringify(this.snapshot())}`); }
}
export async function bounded<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid deadline');
  const controller = new AbortController();
  let rejectDeadline!: (error: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const abort = () => { controller.abort(parent?.reason); rejectDeadline(parent?.reason ?? new Error('CANCELLED')); };
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { const error = new Error('DEADLINE'); controller.abort(error); rejectDeadline(error); }, timeoutMs);
  try { if (controller.signal.aborted) return await cancelled; return await Promise.race([Promise.resolve().then(() => task(controller.signal)), cancelled]); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
export type Fault = 'none' | 'exit' | 'hang' | 'renderer-crash' | 'malformed' | 'slow' | 'navigation';
export class FaultChannel {
  readonly ledger: Ledger;
  #generation = 1;
  #closed = false;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  navigate(): void { this.#generation++; }
  close(): void { this.#closed = true; this.navigate(); }
  async request(value: string, fault: Fault, timeoutMs = 50): Promise<string> {
    if (this.#closed) throw new Error('CHANNEL_CLOSED');
    // Reserve before accepting the request; rejected overload cannot leak an owner.
    const release = this.ledger.reserve(new TextEncoder().encode(value).length);
    const request = this.ledger.acquire('request', 'fault-channel');
    const generation = this.#generation;
    try {
      return await bounded(async signal => {
        if (fault === 'exit' || fault === 'renderer-crash') { this.close(); throw new Error('PEER_EXIT'); }
        if (fault === 'malformed') throw new Error('MALFORMED_ENVELOPE');
        if (fault === 'navigation') this.navigate();
        if (fault === 'hang') return await new Promise<never>((_, reject) => {
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
        });
        if (fault === 'slow') await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 10);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        if (this.#closed || generation !== this.#generation) throw new Error('STALE_DOCUMENT');
        return value;
      }, timeoutMs);
    } finally { release(); request.release(); }
  }
}

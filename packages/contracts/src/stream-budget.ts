import { StreamError } from './stream-wire.ts';
export interface StreamBudgetLimits {
  readonly maxBytes: number;
  readonly maxBytesPerView: number;
  readonly maxBytesPerStream: number;
  readonly maxStreams: number;
  readonly maxStreamsPerView: number;
}
const DEFAULTS: StreamBudgetLimits = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxBytesPerView: 4 * 1024 * 1024,
  maxBytesPerStream: 256 * 1024, maxStreams: 128, maxStreamsPerView: 32 });
/** Trusted host owns this pool and reuses the same view object across replacement connections. */
export class StreamBudget {
  readonly #limits: StreamBudgetLimits;
  readonly #views = new Map<object, { bytes: number; streams: number }>();
  #bytes = 0;
  #streams = 0;
  constructor(limits: Partial<StreamBudgetLimits> = {}) {
    for (const key of Object.keys(limits)) if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError('Unknown stream budget');
    this.#limits = Object.freeze({ ...DEFAULTS, ...limits });
    const l = this.#limits;
    if (!Object.values(l).every(n => Number.isSafeInteger(n) && n > 0) || l.maxBytes > 256 * 1024 * 1024 ||
        l.maxBytesPerStream > l.maxBytesPerView || l.maxBytesPerView > l.maxBytes || l.maxStreamsPerView > l.maxStreams || l.maxStreams > 4096) throw new TypeError('Invalid stream budget');
  }
  /** Reserve the worst-case retained packet capacity before admitting a stream. No waiting queue. */
  reserve(owner: object, bytes: number): () => void {
    if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(bytes) || bytes < 1) throw new TypeError('A trusted view object and byte reservation are required');
    const old = this.#views.get(owner) ?? { bytes: 0, streams: 0 }, l = this.#limits;
    if (bytes > l.maxBytesPerStream || old.bytes + bytes > l.maxBytesPerView || this.#bytes + bytes > l.maxBytes ||
        old.streams >= l.maxStreamsPerView || this.#streams >= l.maxStreams) throw new StreamError('OVERLOADED');
    old.bytes += bytes; old.streams++; this.#bytes += bytes; this.#streams++; this.#views.set(owner, old);
    let released = false;
    return () => {
      if (released) return; released = true; old.bytes -= bytes; old.streams--; this.#bytes -= bytes; this.#streams--;
      if (!old.streams) this.#views.delete(owner);
    };
  }
  diagnostics(owner?: object): Readonly<{ reservedBytes: number; streams: number; views: number }> {
    const view = owner ? this.#views.get(owner) : undefined;
    return { reservedBytes: owner ? view?.bytes ?? 0 : this.#bytes, streams: owner ? view?.streams ?? 0 : this.#streams, views: this.#views.size };
  }
}

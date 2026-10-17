import { BunlyError } from '../../contracts/src/index.ts';
import type { Handle, ResourceKind } from '../../contracts/src/index.ts';
type Entry = { kind: ResourceKind; value: unknown; disposed: boolean };
/** Identity equality, not caller-provided strings. This is not an IPC authenticator. */
export class Registry {
  readonly #entries = new WeakMap<object, Entry>();
  readonly #live = new Set<Handle<ResourceKind>>();
  create<K extends ResourceKind, T>(kind: K, value: T): Handle<K> {
    const handle = Object.freeze({ kind, id: crypto.randomUUID() }) as Handle<K>;
    this.#entries.set(handle, { kind, value, disposed: false });
    this.#live.add(handle);
    return handle;
  }
  get<K extends ResourceKind, T>(handle: Handle<K>, kind: K): T {
    const entry = this.#lookup(handle, kind);
    if (entry.disposed) throw new BunlyError('DISPOSED', `${kind} is disposed`);
    return entry.value as T;
  }
  isDisposed<K extends ResourceKind>(handle: Handle<K>, kind: K): boolean {
    return this.#lookup(handle, kind).disposed;
  }
  dispose<K extends ResourceKind>(handle: Handle<K>, kind: K): boolean {
    const entry = this.#lookup(handle, kind);
    if (entry.disposed) return false;
    entry.disposed = true;
    entry.value = undefined;
    this.#live.delete(handle);
    return true;
  }
  handles<K extends ResourceKind>(kind: K): Handle<K>[] {
    return [...this.#live].filter((h): h is Handle<K> => h.kind === kind);
  }
  #lookup(handle: object, kind: ResourceKind): Entry {
    const entry = handle !== null && typeof handle === 'object' ? this.#entries.get(handle) : undefined;
    if (!entry || entry.kind !== kind) throw new BunlyError('INVALID_HANDLE', `Unknown or foreign ${kind} handle`);
    return entry;
  }
}

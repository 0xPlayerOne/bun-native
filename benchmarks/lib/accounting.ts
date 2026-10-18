import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { inventory } from './inventory.ts';

/** Distinct observations; summing these would double-count downloads and caches. */
export const BYTE_CATEGORIES = ['installed', 'installer', 'first-run-download', 'cache', 'update'] as const;
export type ByteCategory = typeof BYTE_CATEGORIES[number];
export interface ByteObservation {
  readonly category: ByteCategory;
  readonly status: 'measured' | 'unavailable';
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly accounting: 'logical-directory' | 'file-content' | 'received-body' | 'unavailable';
  readonly evidence: string;
}
const digestPattern = /^[a-f0-9]{64}$/;
export function validateByteObservation(input: unknown): ByteObservation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid byte observation');
  const value = input as Record<string, unknown>;
  const fields = ['category', 'status', 'bytes', 'sha256', 'accounting', 'evidence'];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
      !BYTE_CATEGORIES.includes(value['category'] as ByteCategory) || typeof value['evidence'] !== 'string' ||
      !value['evidence'].length || value['evidence'].length > 4096) throw new Error('Invalid byte identity or evidence');
  if (value['status'] === 'unavailable') {
    if (value['bytes'] !== null || value['sha256'] !== null || value['accounting'] !== 'unavailable') throw new Error('Unavailable bytes cannot be zero or hashed');
  } else if (value['status'] === 'measured') {
    if (!Number.isSafeInteger(value['bytes']) || Number(value['bytes']) < 0 || !digestPattern.test(String(value['sha256'])) ||
        !['logical-directory', 'file-content', 'received-body'].includes(String(value['accounting']))) throw new Error('Invalid measured bytes');
    if (value['category'] === 'first-run-download' && value['accounting'] !== 'received-body') throw new Error('Downloads need received-body accounting');
    if (value['category'] === 'installer' && value['accounting'] !== 'file-content') throw new Error('Installer bytes must measure the actual installer file');
  } else throw new Error('Invalid byte status');
  return Object.freeze({ ...value }) as unknown as ByteObservation;
}
export function unavailableBytes(category: ByteCategory, evidence: string): ByteObservation {
  return validateByteObservation({ category, status: 'unavailable', bytes: null, sha256: null, accounting: 'unavailable', evidence });
}
export function validateByteMatrix(rows: readonly ByteObservation[]): readonly ByteObservation[] {
  if (rows.length !== BYTE_CATEGORIES.length) throw new Error('Incomplete byte category matrix');
  const parsed = rows.map(validateByteObservation);
  if (new Set(parsed.map(row => row.category)).size !== BYTE_CATEGORIES.length) throw new Error('Duplicate byte category');
  return Object.freeze(parsed);
}
/** Reads only a declared local artifact; does not follow symlinks or download. */
export async function fileBytes(category: Exclude<ByteCategory, 'first-run-download'>, filename: string, evidence: string): Promise<ByteObservation> {
  const path = resolve(filename), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Expected an ordinary artifact file');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Artifact changed before reading');
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > before.size) throw new Error('Artifact grew while reading');
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(), named = await lstat(path);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) throw new Error('Artifact changed while reading');
    return validateByteObservation({ category, status: 'measured', bytes, sha256: digest.digest('hex'), accounting: 'file-content', evidence });
  } finally { await handle.close(); }
}
export async function directoryBytes(category: 'installed' | 'cache', directory: string, evidence: string): Promise<ByteObservation> {
  const value = await inventory(directory);
  return validateByteObservation({ category, status: 'measured', bytes: value.bytes,
    sha256: createHash('sha256').update(JSON.stringify(value.entries)).digest('hex'), accounting: 'logical-directory', evidence });
}
/** Hashes actual received body chunks. Headers/estimates are not measurements. */
export class DownloadAccounting {
  readonly #hash = createHash('sha256');
  #bytes = 0;
  #closed = false;
  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid download budget');
  }
  receive(chunk: Uint8Array): void {
    if (this.#closed || !(chunk instanceof Uint8Array) || chunk.byteLength > this.maxBytes - this.#bytes) throw new Error('Download accounting is closed or exceeds budget');
    this.#bytes += chunk.byteLength; this.#hash.update(chunk);
  }
  finish(evidence: string): ByteObservation {
    if (this.#closed) throw new Error('Download already finalized');
    this.#closed = true;
    return validateByteObservation({ category: 'first-run-download', status: 'measured', bytes: this.#bytes,
      sha256: this.#hash.digest('hex'), accounting: 'received-body', evidence });
  }
}

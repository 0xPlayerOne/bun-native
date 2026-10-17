import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, opendir, open, rename, rm, mkdtemp, realpath, chmod, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ArtifactError, sha256, verifyManifest } from './manifest.ts';
import type { ArtifactIdentity, ArtifactFile, ArtifactManifest, SignedManifest } from './manifest.ts';
import { readTar } from './tar.ts';

export interface ResolveOptions {
  readonly envelope: SignedManifest;
  readonly trustRoots: Readonly<Record<string, string>>;
  readonly expected: ArtifactIdentity;
  readonly cacheRoot: string;
  readonly allowedOrigins: readonly string[];
  readonly offline?: boolean;
  readonly signal?: AbortSignal;
  /** Entire acquisition deadline, including lock waiting. Default 30 seconds, maximum 10 minutes. */
  readonly timeoutMs?: number;
  /** Additional free disk capacity above block-rounded extracted files/directories. Default 1 MiB. */
  readonly reserveBytes?: number;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
}
function directories(manifest: ArtifactManifest): Set<string> {
  const result = new Set<string>();
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) result.add(parts.slice(0, i).join('/'));
  }
  return result;
}

async function validateFile(path: string, expected: ArtifactFile, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
    throw new ArtifactError('UNSAFE_CACHE', 'Cache files must be single-link regular files');
  // O_NOFOLLOW prevents the final component becoming a symlink on supporting systems.
  // The cache still excludes an actively hostile same-user process from its threat model.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== entry.dev || stat.ino !== entry.ino)
      throw new ArtifactError('UNSAFE_CACHE', 'Cache file identity changed during validation');
    if (stat.size !== expected.size)
      throw new ArtifactError('INTEGRITY_ERROR', `Corrupt cached file size: ${expected.path}`);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== (expected.executable ? 0o700 : 0o600))
      throw new ArtifactError('INTEGRITY_ERROR', 'Cache mode mismatch');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      // Read at most one byte beyond the signed size, never a growing file to EOF.
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, expected.size - size + 1), null);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > expected.size) throw new ArtifactError('INTEGRITY_ERROR', `Cached file grew: ${expected.path}`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (size !== expected.size || after.size !== size || after.nlink !== 1 || hash.digest('hex') !== expected.sha256)
      throw new ArtifactError('INTEGRITY_ERROR', `Corrupt cached file: ${expected.path}`);
    signal.throwIfAborted();
  } finally { await file.close(); }
}

async function validateCache(root: string, manifest: ArtifactManifest, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError('UNSAFE_CACHE', 'Cache entry must be a real directory');
  const expectedFiles = new Map(manifest.files.map(file => [file.path, file]));
  const expectedDirectories = directories(manifest);
  const pending = [''];
  let found = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const base = pending.pop()!;
    // Stream directory entries and reject unexpected directories before descending.
    for await (const entry of await opendir(join(root, base))) {
      signal.throwIfAborted();
      const relative = base ? `${base}/${entry.name}` : entry.name;
      const path = join(root, relative);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new ArtifactError('UNSAFE_CACHE', 'Unexpected cache entry');
      if (info.isDirectory()) {
        if (!expectedDirectories.has(relative)) throw new ArtifactError('INTEGRITY_ERROR', 'Cache directory inventory mismatch');
        pending.push(relative);
      } else {
        const expected = expectedFiles.get(relative);
        if (!expected) throw new ArtifactError('INTEGRITY_ERROR', 'Cache file inventory mismatch');
        await validateFile(path, expected, signal);
        found++;
      }
    }
  }
  if (found !== expectedFiles.size) throw new ArtifactError('INTEGRITY_ERROR', 'Cache file inventory mismatch');
  signal.throwIfAborted();
}

async function checkDiskSpace(root: string, manifest: ArtifactManifest, reserveBytes: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const stats = await statfs(root, { bigint: true });
  signal.throwIfAborted();
  if (stats.bsize <= 0n || stats.bavail < 0n) throw new ArtifactError('DISK_INFO_UNAVAILABLE', 'Cannot determine available cache space');
  const block = stats.bsize;
  const allocatedFiles = manifest.files.reduce((sum, file) => sum + ((BigInt(file.size) + block - 1n) / block) * block, 0n);
  const required = allocatedFiles + BigInt(directories(manifest).size + 1) * block + BigInt(reserveBytes);
  const available = stats.bavail * block;
  if (available < required)
    throw new ArtifactError('INSUFFICIENT_DISK_SPACE', `Artifact staging requires ${required} free bytes; ${available} available`);
}

/** Race untrusted I/O with the deadline; late settlement is consumed, not an unhandled rejection. */
function abortable<T>(work: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); onAbort?.(); reject(signal.reason); };
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
function cancelBody(response: Response): void { void response.body?.cancel().catch(() => {}); }

async function download(manifest: ArtifactManifest, options: ResolveOptions, signal: AbortSignal): Promise<Uint8Array> {
  const fetcher = options.fetcher ?? ((url: string, init: RequestInit) => fetch(url, init));
  let url = new URL(manifest.archive.url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !options.allowedOrigins.includes(url.origin))
      throw new ArtifactError('UNTRUSTED_ORIGIN', 'Artifact origin not allowed');
    const response = await abortable(Promise.resolve().then(() => {
      signal.throwIfAborted();
      return fetcher(url.href, { redirect: 'manual', credentials: 'omit', signal });
    }).then(value => {
      if (signal.aborted) { cancelBody(value); signal.throwIfAborted(); }
      return value;
    }), signal);
    if (response.redirected) { cancelBody(response); throw new ArtifactError('UNTRUSTED_ORIGIN', 'Fetcher bypassed manual redirect validation'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      cancelBody(response);
      if (!location) throw new ArtifactError('DOWNLOAD_FAILED', 'Redirect missing location');
      try { url = new URL(location, url); }
      catch { throw new ArtifactError('DOWNLOAD_FAILED', 'Invalid redirect URL'); }
      continue;
    }
    if (response.status !== 200 || !response.body) { cancelBody(response); throw new ArtifactError('DOWNLOAD_FAILED', `Unexpected download status ${response.status}`); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== manifest.archive.size)) {
      cancelBody(response); throw new ArtifactError('INTEGRITY_ERROR', 'Archive length differs from manifest');
    }
    const reader = response.body.getReader();
    // Restricted probe archives remain capped at 64 MiB. Avoid an unbounded array of chunks.
    const bytes = Buffer.alloc(manifest.archive.size);
    let size = 0;
    const cancel = (): void => { void reader.cancel(signal.reason).catch(() => {}); };
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await abortable(reader.read(), signal, cancel);
        signal.throwIfAborted();
        if (chunk.done) break;
        if (chunk.value.length > bytes.length - size) throw new ArtifactError('INTEGRITY_ERROR', 'Archive exceeds signed size');
        bytes.set(chunk.value, size); size += chunk.value.length;
      }
    } catch (error) { cancel(); throw error; }
    finally { reader.releaseLock(); }
    if (size !== manifest.archive.size || sha256(bytes) !== manifest.archive.sha256)
      throw new ArtifactError('INTEGRITY_ERROR', 'Archive integrity check failed');
    signal.throwIfAborted();
    return bytes;
  }
  throw new ArtifactError('DOWNLOAD_FAILED', 'Too many redirects');
}

export type InspectOptions = Pick<ResolveOptions, 'envelope' | 'trustRoots' | 'expected' | 'cacheRoot' | 'signal' | 'timeoutMs'>;

function operationSignal(options: Pick<ResolveOptions, 'timeoutMs' | 'signal'>): AbortSignal {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new ArtifactError('INVALID_ARGUMENT', 'Invalid acquisition deadline');
  const deadline = AbortSignal.timeout(timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
}

/** Read-only inspection of one independently authenticated, exact artifact identity. */
export async function inspectArtifact(options: InspectOptions): Promise<{ directory: string; status: 'verified' | 'missing' }> {
  const manifest = verifyManifest(options.envelope, options.trustRoots, options.expected);
  const signal = operationSignal(options);
  signal.throwIfAborted();
  const requestedRoot = resolve(options.cacheRoot);
  const present = await exists(requestedRoot);
  signal.throwIfAborted();
  if (!present) return { directory: join(requestedRoot, manifest.archive.sha256), status: 'missing' };
  const stat = await lstat(requestedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError('UNSAFE_CACHE', 'Cache root is not a directory');
  const directory = join(await realpath(requestedRoot), manifest.archive.sha256);
  const cached = await exists(directory);
  signal.throwIfAborted();
  if (!cached) return { directory, status: 'missing' };
  await validateCache(directory, manifest, signal);
  return { directory, status: 'verified' };
}

/** No compiler fallback. Private per-user cache; no automatic takeover of potentially live locks. */
export async function resolveArtifact(options: ResolveOptions): Promise<{ directory: string; cacheHit: boolean }> {
  const manifest = verifyManifest(options.envelope, options.trustRoots, options.expected);
  const signal = operationSignal(options);
  const reserveBytes = options.reserveBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0)
    throw new ArtifactError('INVALID_ARGUMENT', 'Invalid disk reserve');
  signal.throwIfAborted();
  await mkdir(options.cacheRoot, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  const rootStat = await lstat(options.cacheRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ArtifactError('UNSAFE_CACHE', 'Cache root is not a directory');
  const root = await realpath(options.cacheRoot);
  const destination = join(root, manifest.archive.sha256);
  if (await exists(destination)) { await validateCache(destination, manifest, signal); return { directory: destination, cacheHit: true }; }
  signal.throwIfAborted();
  if (options.offline) throw new ArtifactError('MISSING_ARTIFACT', `No verified cache entry for ${manifest.identity.target}; offline mode never builds from source`);
  const lockPath = join(root, `${manifest.archive.sha256}.lock`);
  let lock: FileHandle | undefined;
  while (!lock) {
    signal.throwIfAborted();
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      try {
        const stat = await lstat(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ArtifactError('UNSAFE_CACHE', 'Cache lock is not a private regular file');
      } catch (error) { if (code(error) !== 'ENOENT') throw error; }
      // A cancelled waiter must never unlink another consumer's lock.
      await delay(25, undefined, { signal }).catch(error => { if (signal.aborted) signal.throwIfAborted(); throw error; });
    }
  }
  const ownedLock = lock;
  let stage: string | undefined;
  let failed = false;
  let failure: unknown;
  let result: { directory: string; cacheHit: boolean } | undefined;
  try {
    result = await (async () => {
      if (await exists(destination)) { await validateCache(destination, manifest, signal); return { directory: destination, cacheHit: true }; }
      await checkDiskSpace(root, manifest, reserveBytes, signal);
      const bytes = await download(manifest, options, signal);
      const members = readTar(bytes);
      const expected = new Map(manifest.files.map(file => [file.path, file]));
      if (members.length !== expected.size) throw new ArtifactError('INTEGRITY_ERROR', 'Archive inventory mismatch');
      for (const member of members) {
        signal.throwIfAborted();
        const file = expected.get(member.path);
        if (!file || file.size !== member.bytes.length || sha256(member.bytes) !== file.sha256)
          throw new ArtifactError('INTEGRITY_ERROR', 'Archive member differs from signed manifest');
      }
      stage = await mkdtemp(join(root, `.${manifest.archive.sha256}.stage-`));
      for (const member of members) {
        signal.throwIfAborted();
        const path = join(stage, member.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(member.bytes); await file.sync(); }
        finally { await file.close(); }
        await chmod(path, expected.get(member.path)!.executable ? 0o700 : 0o600);
      }
      await validateCache(stage, manifest, signal);
      signal.throwIfAborted();
      await rename(stage, destination); stage = undefined;
      return { directory: destination, cacheHit: false };
    })();
  } catch (error) {
    failed = true;
    failure = ['ENOSPC', 'EDQUOT'].includes(code(error) ?? '')
      ? new ArtifactError('INSUFFICIENT_DISK_SPACE', `Artifact staging failed (${code(error)}); no verified entry published`)
      : error;
  }
  {
    // Each cleanup is attempted even if another fails. Do not silently strand the lock.
    const cleanupErrors: unknown[] = [];
    if (stage) { try { await rm(stage, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); } }
    try { await ownedLock.close(); } catch (error) { cleanupErrors.push(error); }
    try { await rm(lockPath, { force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, 'Artifact cache cleanup failed');
  }
  if (failed) throw failure;
  if (!result) throw new ArtifactError('RESOLUTION_FAILED', 'Artifact acquisition produced no result');
  return result;
}

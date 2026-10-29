import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { BunlyError } from '../../contracts/src/core.ts'
import type {
  PersistentSessionResetOptions,
  PersistentSessionResetResult,
} from '../../contracts/src/session-reset.ts'

const CONFIRMATION = 'delete-entire-profile'
const OUTPUT_LIMIT = 64 * 1024
const RESULT_KEYS = [
  'schema',
  'partition',
  'offline',
  'storageCleared',
  'cookiesCleared',
  'cacheCleared',
  'recoveredInterruption',
  'remainingEntriesRemoved',
  'remainingLogicalBytesRemoved',
]
  .sort()
  .join(',')

function absolute(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\0') ||
    !isAbsolute(value)
  )
    throw new BunlyError('INVALID_ARGUMENT', `${label} must be a bounded absolute path`)
}

async function requireMaintenanceProtocol(host: string): Promise<void> {
  const executable = await lstat(host)
  if (!executable.isFile() || executable.isSymbolicLink())
    throw new BunlyError('INVALID_ARGUMENT', 'Select a real installed native executable')
  const resources =
    process.platform === 'darwin'
      ? join(dirname(dirname(host)), 'Resources')
      : join(dirname(host), 'resources')
  const path = join(resources, 'runtime.json')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new BunlyError(
      'UNSUPPORTED_CAPABILITY',
      'Installed runtime lacks bounded maintenance metadata'
    )
  const file = await open(path, 'r')
  let data: unknown
  try {
    const buffer = new Uint8Array(4097)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 4096) throw new Error('Maintenance metadata exceeded its bound')
    data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    )
  } finally {
    await file.close()
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    (data as Record<string, unknown>)['schema'] !== 1 ||
    (data as Record<string, unknown>)['protocol'] !== 1 ||
    (data as Record<string, unknown>)['bun_version'] !== '1.4.4' ||
    (data as Record<string, unknown>)['maintenance_protocol'] !== 1
  )
    throw new BunlyError(
      'UNSUPPORTED_CAPABILITY',
      'Installed runtime does not support offline session reset'
    )
}

function result(text: string, partition: string): Readonly<PersistentSessionResetResult> {
  const lines = text.trim().split('\n')
  if (lines.length !== 1) throw new Error('Missing or duplicate native reset receipt')
  const record: unknown = JSON.parse(lines[0]!)
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new Error('Invalid native reset receipt')
  const envelope = record as Record<string, unknown>
  if (
    Object.keys(envelope).sort().join(',') !== 'event,result' ||
    envelope['event'] !== 'bunly.session.storage-reset'
  )
    throw new Error('Unexpected native reset receipt')
  const value = envelope['result']
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native reset result')
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).sort().join(',') !== RESULT_KEYS ||
    v['schema'] !== 1 ||
    v['partition'] !== partition ||
    !['offline', 'storageCleared', 'cookiesCleared', 'cacheCleared'].every(
      (key) => v[key] === true
    ) ||
    typeof v['recoveredInterruption'] !== 'boolean' ||
    !['remainingEntriesRemoved', 'remainingLogicalBytesRemoved'].every(
      (key) => Number.isSafeInteger(v[key]) && Number(v[key]) >= 0
    ) ||
    Number(v['remainingEntriesRemoved']) > 65536
  )
    throw new Error('Native reset evidence does not match the requested operation')
  return Object.freeze(value as PersistentSessionResetResult)
}

/** Delete one entire persistent profile only while its native root lock is free.
 * This is an explicit, destructive offline API. It does not claim selective live
 * HTML5 clearing, secure overwrite, or protection against a hostile same-user
 * filesystem race. A failed/interrupted reset leaves a native intent fence;
 * callers must retry the same explicit operation before reopening that partition.
 */
export async function resetPersistentSessionStorage(
  options: PersistentSessionResetOptions
): Promise<Readonly<PersistentSessionResetResult>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    options.confirmation !== CONFIRMATION
  )
    throw new BunlyError(
      'INVALID_ARGUMENT',
      'Offline reset requires explicit delete-entire-profile confirmation'
    )
  absolute(options.hostExecutable, 'Native runtime')
  absolute(options.persistentRoot, 'Persistent root')
  if (
    typeof options.partition !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.partition)
  )
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid persistent partition')
  const timeoutMs = options.timeoutMs ?? 30000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new BunlyError('INVALID_ARGUMENT', 'Invalid offline reset deadline')
  options.signal?.throwIfAborted()
  await requireMaintenanceProtocol(options.hostExecutable)
  options.signal?.throwIfAborted()
  // Older prebuilds are rejected before spawn: unknown flags must never launch
  // an old runtime's ordinary application as a maintenance side effect.
  const child = Bun.spawn(
    [
      options.hostExecutable,
      `--bunly-reset-profile=${options.partition}`,
      '--bunly-confirm-profile-reset',
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BUNLY_PROFILE_ROOT: options.persistentRoot },
    }
  )
  let failure: Error | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let ended = false
  function stop(reason: Error) {
    if (failure) return
    failure = reason
    if (ended) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* Owned child may already have exited. */
    }
    killTimer = setTimeout(() => {
      if (!ended) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
    }, 500)
  }
  let totalBytes = 0
  async function drain(stream: ReadableStream<Uint8Array>, retain: boolean): Promise<string> {
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of stream) {
      totalBytes += chunk.byteLength
      if (totalBytes > OUTPUT_LIMIT) {
        stop(new Error('Native reset output exceeded its bound'))
        continue
      }
      if (retain) {
        chunks.push(new Uint8Array(chunk))
        bytes += chunk.byteLength
      }
    }
    const output = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(output)
  }
  const abort = () =>
    stop(
      new DOMException('Offline session reset cancelled; completion is unverified', 'AbortError')
    )
  const deadline = setTimeout(
    () =>
      stop(
        new DOMException(
          'Offline session reset timed out; completion is unverified',
          'TimeoutError'
        )
      ),
    timeoutMs
  )
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    const exit = child.exited.then((code) => {
      ended = true
      return code
    })
    const [code, stdout] = await Promise.all([
      exit,
      drain(child.stdout, true),
      drain(child.stderr, false),
    ])
    if (failure) throw failure
    if (code !== 0)
      throw new Error(
        `Native offline reset rejected or incomplete (exit ${code}); profile data was not qualified as cleared`
      )
    return result(stdout, options.partition)
  } finally {
    clearTimeout(deadline)
    if (killTimer) clearTimeout(killTimer)
    options.signal?.removeEventListener('abort', abort)
    if (!ended) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* Owned child already gone. */
      }
      await child.exited
    }
  }
}

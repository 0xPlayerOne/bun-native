import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { sha256 } from './artifact.ts'
import { prebuiltHost } from './host.ts'

/** The platforms whose release host archives the release workflow attaches (ADR 0021). */
export const releaseHostTargets = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
] as const
export type ReleaseHostTarget = (typeof releaseHostTargets)[number]

const releases = 'https://github.com/0xPlayerOne/bun-native/releases/download'
const maximumArchiveBytes = 512 * 1024 * 1024
const maximumChecksumBytes = 64 * 1024
const defaultTimeoutMs = 5 * 60_000

export function releaseHostTarget(
  platform: string = process.platform,
  arch: string = process.arch
): ReleaseHostTarget {
  const target = `${platform}-${arch}`
  if (!(releaseHostTargets as readonly string[]).includes(target))
    throw new Error(
      `No released native host for ${target}; supply --host with a host built from source (released: ${releaseHostTargets.join(', ')})`
    )
  return target as ReleaseHostTarget
}

export function releaseHostAsset(target: ReleaseHostTarget): string {
  return `bun-native-host-${target}.tar.gz`
}

/** The expected digest of `asset` from a release's `sha256sum`-format SHA256SUMS. */
export function checksumFor(sums: string, asset: string): string {
  const matches = sums
    .split('\n')
    .map((line) => /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line.trimEnd()))
    .filter((match): match is RegExpExecArray => match !== null && match[2] === asset)
  if (matches.length !== 1)
    throw new Error(`SHA256SUMS must list ${asset} exactly once (found ${matches.length})`)
  return matches[0]![1]!
}

function octal(header: Buffer, offset: number, length: number): number {
  const text = header.toString('latin1', offset, offset + length).replace(/[\0 ]+$/, '')
  if (!/^[0-7]+$/.test(text)) throw new Error('Host archive has an invalid USTAR number')
  return Number.parseInt(text, 8)
}

/**
 * The single `bun-native-host` member of a host archive made by host-archive.ts:
 * a gzip-compressed USTAR stream with exactly one regular file, mode 0755.
 */
export function hostFromArchive(archive: Uint8Array): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: maximumArchiveBytes })
  if (tar.length < 1024 || tar.length % 512 !== 0) throw new Error('Host archive is truncated')
  const header = tar.subarray(0, 512)
  const name = header.toString('latin1', 0, 100).replace(/\0+$/, '')
  if (name !== 'bun-native-host')
    throw new Error(`Host archive must hold only bun-native-host, not ${name || 'nothing'}`)
  if (header[156] !== 0x30 && header[156] !== 0)
    throw new Error('Host member is not a regular file')
  if (header.toString('latin1', 257, 262) !== 'ustar') throw new Error('Host archive is not USTAR')
  let checksum = 0
  for (let index = 0; index < 512; index++)
    checksum += index >= 148 && index < 156 ? 0x20 : header[index]!
  if (checksum !== octal(header, 148, 8)) throw new Error('Host archive header checksum mismatch')
  const size = octal(header, 124, 12)
  const end = 512 + Math.ceil(size / 512) * 512
  if (size === 0 || end + 1024 > tar.length) throw new Error('Host archive is truncated')
  if (tar.subarray(end).some((byte) => byte !== 0))
    throw new Error('Host archive must hold exactly one member')
  return Buffer.from(tar.subarray(512, 512 + size))
}

/**
 * One bounded download: the same deadline covers the request and the whole body,
 * which is streamed into a byte-limited buffer (the install-bun/download.mjs pattern).
 * A stalled release server fails the command instead of hanging it.
 */
async function download(url: string, limit: number, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController()
  const expired = () => new Error(`Download exceeded ${timeoutMs} ms: ${url}`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(expired())
    }, timeoutMs)
  })
  const operation = (async () => {
    let response: Response
    try {
      response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw expired()
      throw error
    }
    try {
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > limit) throw new Error(`Download is larger than ${limit} bytes: ${url}`)
      const parts: Uint8Array[] = []
      let total = 0
      for await (const part of response.body ?? []) {
        total += part.byteLength
        if (total > limit) throw new Error(`Download is larger than ${limit} bytes: ${url}`)
        parts.push(part)
      }
      return Buffer.concat(parts, total)
    } catch (error) {
      if (controller.signal.aborted) throw expired()
      throw error
    } finally {
      // Release the connection on every early exit; a completed body is a no-op.
      controller.abort()
    }
  })()
  try {
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
    operation.catch(() => {})
  }
}

export type HostInstallOptions = {
  version: string
  /** Release download base; the tag directory is appended. Defaults to GitHub releases. */
  baseUrl?: string
  /** Directory that holds one host per version and target. */
  cache: string
  force?: boolean
  target?: ReleaseHostTarget
  /** Deadline for each download, request and body together. Defaults to 5 minutes. */
  timeoutMs?: number
}

function installedHostPath(options: HostInstallOptions): string {
  const target = options.target ?? releaseHostTarget()
  return join(options.cache, `v${options.version}`, target, 'bun-native-host')
}

/**
 * Download this version's release host for the current OS and CPU, check the
 * archive against the release's SHA256SUMS, unpack its one member and check its
 * executable header. A cached host from an earlier install is reused unless
 * `force` is set. The host is unsigned; the checksum proves only that the bytes
 * match what the release workflow attached (docs/developer-tooling.md).
 */
export async function installReleaseHost(options: HostInstallOptions): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(options.version))
    throw new Error(`Release host version must be x.y.z, not ${options.version}`)
  const target = options.target ?? releaseHostTarget()
  const destination = installedHostPath({ ...options, target })
  if (!options.force && (await stat(destination).catch(() => undefined))?.isFile())
    return prebuiltHost(destination)
  const base = `${(options.baseUrl ?? process.env['BUN_NATIVE_HOST_RELEASE_URL'] ?? releases).replace(/\/+$/, '')}/v${options.version}`
  const asset = releaseHostAsset(target)
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const sums = new TextDecoder().decode(
    await download(`${base}/SHA256SUMS`, maximumChecksumBytes, timeoutMs)
  )
  const expected = checksumFor(sums, asset)
  const archive = await download(`${base}/${asset}`, maximumArchiveBytes, timeoutMs)
  const actual = sha256(archive)
  if (actual !== expected)
    throw new Error(`${asset} digest ${actual} does not match SHA256SUMS ${expected}`)
  const host = hostFromArchive(archive)
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.${process.pid}.partial`
  try {
    await writeFile(partial, host, { mode: 0o755 })
    await chmod(partial, 0o755)
    await prebuiltHost(partial)
    await rename(partial, destination)
  } finally {
    await rm(partial, { force: true })
  }
  await writeFile(`${destination}.archive.sha256`, `${actual}  ${asset}\n`)
  return prebuiltHost(destination)
}

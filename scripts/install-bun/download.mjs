import { createHash } from 'node:crypto'

export const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024
export const MAX_UNPACKED_BYTES = 192 * 1024 * 1024

/** @typedef {{name: string, version: string, url: string, integrity: string, unpackedSize: number}} PackagePin */

/** @param {PackagePin} pin */
export function validatePackagePin(pin) {
  if (
    !pin ||
    typeof pin !== 'object' ||
    typeof pin.name !== 'string' ||
    typeof pin.version !== 'string' ||
    !/^@oven\/bun-(linux|darwin|windows)-(x64|aarch64)$/.test(pin.name) ||
    !/^\d+\.\d+\.\d+-canary\.\d{8}\.\d+\+[a-f0-9]{7}$/.test(pin.version) ||
    pin.version.length > 64
  )
    throw new Error('Invalid exact official Bun package pin')
  // npm strips SemVer build metadata from its registry version and tarball name.
  // The package.json inside the verified archive retains the exact full version.
  const expected = `https://registry.npmjs.org/${pin.name}/-/${pin.name.slice(6)}-${pin.version.split('+')[0]}.tgz`
  if (pin.url !== expected) throw new Error('Bun package URL must be its exact public npm archive')
  if (typeof pin.integrity !== 'string') throw new Error('Invalid pinned Bun SHA-512 integrity')
  const encoded = pin.integrity.replace(/^sha512-/, '')
  if (
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity) ||
    Buffer.from(encoded, 'base64').toString('base64') !== encoded
  )
    throw new Error('Invalid pinned Bun SHA-512 integrity')
  if (
    !Number.isSafeInteger(pin.unpackedSize) ||
    pin.unpackedSize <= 0 ||
    pin.unpackedSize > MAX_UNPACKED_BYTES - 16_384
  )
    throw new Error('Invalid pinned Bun unpacked size')
  return new URL(expected)
}

/**
 * One exact public npm archive, no credentials, redirects, retries or fallback.
 * The same deadline bounds the request and complete body. Tests may shorten it.
 * @param {PackagePin} pin
 * @param {{fetchImplementation?: (url: URL, options: RequestInit) => Promise<Response>, report?: (value: {phase: string, status: number}) => void, timeoutMs?: number, maxArchiveBytes?: number}} options
 */
export async function downloadPinnedArchive(
  pin,
  {
    fetchImplementation = fetch,
    report = (value) => console.error(JSON.stringify({ bunDownload: value })),
    timeoutMs = 120_000,
    maxArchiveBytes = MAX_ARCHIVE_BYTES,
  } = {}
) {
  const url = validatePackagePin(pin)
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)
    throw new Error('Invalid Bun download deadline')
  if (
    !Number.isInteger(maxArchiveBytes) ||
    maxArchiveBytes <= 0 ||
    maxArchiveBytes > MAX_ARCHIVE_BYTES
  )
    throw new Error('Invalid Bun compressed byte bound')
  const controller = new AbortController()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Pinned Bun download exceeded its deadline'))
    }, timeoutMs)
  })
  /** @type {Response | undefined} */
  let response
  /** @type {import('node:stream/web').ReadableStreamDefaultReader<Uint8Array> | undefined} */
  let reader
  try {
    try {
      response = await Promise.race([
        fetchImplementation(url, {
          headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        }),
        deadline,
      ])
    } catch {
      throw new Error(
        controller.signal.aborted
          ? 'Pinned Bun download exceeded its deadline'
          : 'Pinned Bun download request failed'
      )
    }
    report({ phase: 'npm-archive', status: response.status })
    if (response.status !== 200)
      throw new Error(`Pinned Bun download failed with HTTP ${response.status}`)
    if (
      response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity'
    )
      throw new Error('Pinned Bun archive must use identity HTTP encoding')
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d{1,12}$/.test(length) || Number(length) > maxArchiveBytes))
      throw new Error('Pinned Bun archive exceeds its compressed byte bound')
    if (!response.body) throw new Error('Pinned Bun archive has no response body')
    const activeReader = response.body.getReader()
    reader = activeReader
    const digest = createHash('sha512')
    /** @type {Uint8Array[]} */
    const chunks = []
    let total = 0
    for (;;) {
      let part
      try {
        part = await Promise.race([activeReader.read(), deadline])
      } catch {
        throw new Error(
          controller.signal.aborted
            ? 'Pinned Bun download exceeded its deadline'
            : 'Pinned Bun download body failed'
        )
      }
      if (part.done) break
      total += part.value.byteLength
      if (total > maxArchiveBytes)
        throw new Error('Pinned Bun archive exceeds its compressed byte bound')
      digest.update(part.value)
      chunks.push(part.value)
    }
    if (length !== null && total !== Number(length))
      throw new Error('Pinned Bun archive length mismatch')
    if (`sha512-${digest.digest('base64')}` !== pin.integrity)
      throw new Error('Pinned Bun archive checksum mismatch')
    return Buffer.concat(chunks, total)
  } finally {
    clearTimeout(timer)
    // Cancellation is best effort and cannot extend the request's deadline.
    if (reader) void reader.cancel().catch(() => {})
    else void response?.body?.cancel().catch(() => {})
  }
}

import { createHash } from 'node:crypto'

const storageHosts = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])
const redirectStatuses = new Set([301, 302, 303, 307, 308])

/** @typedef {{phase: string, status: number, authenticated: boolean, rateLimit: Record<string, number>, requestId?: string, retryAfterSeconds?: number}} DownloadMetadata */

/** @param {Response} response @param {string} phase @param {boolean} authenticated */
function metadata(response, phase, authenticated) {
  /** @type {DownloadMetadata} */
  const result = { phase, status: response.status, authenticated, rateLimit: {} }
  for (const name of ['limit', 'remaining', 'used', 'reset']) {
    const value = response.headers.get(`x-ratelimit-${name}`)
    if (value && /^\d{1,12}$/.test(value)) result.rateLimit[name] = Number(value)
  }
  const requestId = response.headers.get('x-github-request-id')
  if (requestId && /^[\da-f:]{1,128}$/i.test(requestId)) result.requestId = requestId
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter && /^\d{1,12}$/.test(retryAfter)) result.retryAfterSeconds = Number(retryAfter)
  return result
}

/**
 * Fetch one immutable public GitHub asset. Authentication is sent only to its
 * initial API URL, never to a storage redirect. Tests inject HTTP responses;
 * production always uses the platform fetch implementation.
 * @param {{assetId: number, sha256: string}} archive
 * @param {{token?: string, fetchImplementation?: (url: URL, options: RequestInit) => Promise<Response>, report?: (value: DownloadMetadata) => void}} options
 */
export async function downloadPinnedArchive(
  archive,
  {
    token,
    fetchImplementation = fetch,
    report = (value) => console.error(JSON.stringify({ bunDownload: value })),
  } = {}
) {
  if (!Number.isSafeInteger(archive.assetId) || archive.assetId <= 0)
    throw new Error('Pinned Bun asset ID must be a positive safe integer')
  if (!/^[a-f\d]{64}$/.test(archive.sha256)) throw new Error('Invalid pinned Bun archive checksum')
  if (
    token !== undefined &&
    (typeof token !== 'string' || (token !== '' && !/^[\x21-\x7e]+$/.test(token)))
  )
    throw new Error('BUN_NATIVE_GITHUB_TOKEN must contain a single token without whitespace')
  const signal = AbortSignal.timeout(120_000)
  let url = new URL(`https://api.github.com/repos/oven-sh/bun/releases/assets/${archive.assetId}`)
  for (let redirects = 0; ; redirects++) {
    const authenticated = redirects === 0 && Boolean(token)
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/octet-stream' }
    if (redirects === 0) headers['X-GitHub-Api-Version'] = '2022-11-28'
    if (authenticated) headers.Authorization = `Bearer ${token}`
    let response
    try {
      response = await fetchImplementation(url, { headers, signal, redirect: 'manual' })
    } catch {
      // Fetch errors can contain signed redirect URLs. Keep them out of logs.
      throw new Error(
        signal.aborted
          ? 'Pinned Bun download exceeded its deadline'
          : 'Pinned Bun download request failed'
      )
    }
    report(metadata(response, redirects === 0 ? 'asset-api' : 'asset-storage', authenticated))
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (redirects === 5) throw new Error('Pinned Bun download exceeded its redirect limit')
      let next
      try {
        next = new URL(location ?? '')
      } catch {
        throw new Error('Pinned Bun asset returned an invalid redirect')
      }
      if (
        next.protocol !== 'https:' ||
        next.username ||
        next.password ||
        next.port ||
        !storageHosts.has(next.hostname)
      )
        throw new Error('Pinned Bun asset redirected outside approved HTTPS storage')
      url = next
      continue
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Pinned Bun download failed with HTTP ${response.status}`)
    }
    let bytes
    try {
      bytes = Buffer.from(await response.arrayBuffer())
    } catch {
      throw new Error(
        signal.aborted
          ? 'Pinned Bun download exceeded its deadline'
          : 'Pinned Bun download body failed'
      )
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== archive.sha256)
      throw new Error(`Bun archive checksum mismatch: expected ${archive.sha256}, got ${digest}`)
    return bytes
  }
}

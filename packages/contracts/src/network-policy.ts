import { BunlyError } from './core.ts'

/** Navigation and HTTP(S) resource policy, not a general process/network firewall.
 * Never grants application RPC authority. HTTP is limited to explicit numeric
 * loopback origins; all other permitted origins must use HTTPS.
 */
export interface SessionNetworkPolicy {
  readonly allowedOrigins: readonly string[]
}

/** Snapshot untrusted runtime input before any asynchronous native operation. */
export function normalizeSessionNetworkPolicy(value: unknown): SessionNetworkPolicy {
  const invalid = () =>
    new BunlyError(
      'INVALID_ARGUMENT',
      'Expected at most 32 unique exact HTTPS or numeric-loopback HTTP origins'
    )
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'allowedOrigins')
  )
    throw invalid()
  const origins = (value as Record<string, unknown>)['allowedOrigins']
  if (!Array.isArray(origins) || origins.length > 32) throw invalid()
  const copy: string[] = []
  const seen = new Set<string>()
  for (const origin of origins) {
    if (typeof origin !== 'string' || origin.length === 0 || origin.length > 256) throw invalid()
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw invalid()
    }
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !url.hostname ||
      url.hostname.includes('*') ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          url.port !== '' &&
          Number(url.port) > 0)
      ) ||
      (url.port !== '' && Number(url.port) === 0) ||
      seen.has(origin)
    )
      throw invalid()
    seen.add(origin)
    copy.push(origin)
  }
  return Object.freeze({ allowedOrigins: Object.freeze(copy) })
}

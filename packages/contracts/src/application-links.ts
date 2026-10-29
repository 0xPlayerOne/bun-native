import { BunlyError } from './core.ts'
import type { PolicyScope } from './desktop.ts'
import type { OperationOptions } from './index.ts'

export const APPLICATION_LINK_LIMITS = Object.freeze({
  routes: 8,
  schemeBytes: 32,
  hostBytes: 64,
  pathBytes: 128,
  manifestBytes: 2048,
  urlBytes: 2048,
  queueEntries: 16,
  queueBytes: 16384,
  readers: 1,
})
export interface ApplicationLinkRoute {
  readonly scheme: string
  readonly host: string
  readonly path: string
}
/** Application configuration only; declaring a route does not register an OS protocol handler. */
export interface ApplicationLinksManifest {
  readonly schema: 1
  readonly routes: readonly ApplicationLinkRoute[]
}
declare const readerBrand: unique symbol
export interface ApplicationLinkReader {
  readonly id: string
  readonly [readerBrand]: true
}
export interface ApplicationLink {
  readonly sequence: number
  /** Validated routing is not content trust. Treat the query as untrusted application input. */
  readonly url: string
  readonly source: 'startup' | 'macos'
}
declare const batchBrand: unique symbol
export interface ApplicationLinkBatch {
  readonly links: readonly ApplicationLink[]
  /** Rejected arrivals since the last acknowledged snapshot; accepted entries are never evicted. */
  readonly overflow: number
  readonly [batchBrand]: true
}
export interface ApplicationLinksBackend {
  createApplicationLinkReader(
    scope: PolicyScope,
    options?: OperationOptions
  ): Promise<ApplicationLinkReader>
  readApplicationLinks(reader: ApplicationLinkReader): Promise<ApplicationLinkBatch>
  /** Only the authentic latest read batch may be acknowledged. */
  acknowledgeApplicationLinks(
    reader: ApplicationLinkReader,
    batch: ApplicationLinkBatch
  ): Promise<void>
  /** Releases the reader; queued links remain available to a subsequently authorized reader. */
  disposeApplicationLinkReader(reader: ApplicationLinkReader): Promise<void>
  /** OS submission only. Success does not attest that a browser opened or loaded the URL. */
  openExternalUrl(scope: PolicyScope, url: string): Promise<void>
}
const reserved = new Set([
  'http',
  'https',
  'file',
  'data',
  'javascript',
  'about',
  'bunly',
  'ws',
  'wss',
  'ftp',
])
function invalid(): never {
  throw new BunlyError('INVALID_ARGUMENT', 'Invalid application link')
}
function exact(value: unknown, expression: RegExp, maximum: number): value is string {
  return (
    typeof value === 'string' && value.length <= maximum && expression.exec(value)?.[0] === value
  )
}
function route(input: unknown): Readonly<ApplicationLinkRoute> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  const value = input as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'host,path,scheme') invalid()
  const { scheme, host, path } = value
  if (
    !exact(scheme, /^[a-z][a-z0-9+.-]+$/, APPLICATION_LINK_LIMITS.schemeBytes) ||
    reserved.has(scheme) ||
    !exact(host, /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, APPLICATION_LINK_LIMITS.hostBytes) ||
    !exact(path, /^\/[A-Za-z0-9._~/-]*$/, APPLICATION_LINK_LIMITS.pathBytes) ||
    path.split('/').some((segment) => segment === '.' || segment === '..') ||
    path.includes('//')
  )
    invalid()
  return Object.freeze({ scheme, host, path })
}
export function normalizeApplicationLinksManifest(input: unknown): ApplicationLinksManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !== 'routes,schema' ||
    value['schema'] !== 1 ||
    !Array.isArray(value['routes']) ||
    value['routes'].length < 1 ||
    value['routes'].length > APPLICATION_LINK_LIMITS.routes
  )
    invalid()
  const routes = value['routes'].map(route)
  const manifest = Object.freeze({ schema: 1 as const, routes: Object.freeze(routes) })
  const encoded = JSON.stringify(manifest)
  if (
    encoded.length > APPLICATION_LINK_LIMITS.manifestBytes ||
    new Set(routes.map((item) => JSON.stringify(item))).size !== routes.length
  )
    invalid()
  return manifest
}
function parsedUrl(input: unknown): URL {
  if (
    !exact(input, /^[\x21-\x7e]+$/, APPLICATION_LINK_LIMITS.urlBytes) ||
    input.includes('\\') ||
    input.includes('#') ||
    /%(?![a-fA-F0-9]{2})/.test(input)
  )
    invalid()
  let url
  try {
    url = new URL(input)
  } catch {
    invalid()
  }
  if (url.href !== input || url.username || url.password) invalid()
  return url
}
/** Canonical ASCII routing excludes alternate encodings, credentials, ports and fragments. */
export function normalizeApplicationLinkUrl(input: unknown): string {
  const url = parsedUrl(input)
  if (url.port) invalid()
  route({ scheme: url.protocol.slice(0, -1), host: url.hostname, path: url.pathname })
  return url.href
}
export function matchesApplicationLinkRoute(
  manifest: ApplicationLinksManifest,
  input: unknown
): boolean {
  try {
    const url = new URL(normalizeApplicationLinkUrl(input))
    return manifest.routes.some(
      (item) =>
        item.scheme + ':' === url.protocol &&
        item.host === url.hostname &&
        item.path === url.pathname
    )
  } catch {
    return false
  }
}
export function normalizeExternalHttpsUrl(input: unknown): string {
  const url = parsedUrl(input)
  if (url.protocol !== 'https:' || !url.hostname) invalid()
  return url.href
}

/** Completion-only instrumentation for private desktop edit fixtures, not native IPC. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
export interface DesktopHost {
  readonly launch: string
  readonly revision: string
  readonly instance: string
  readonly state: string
  readonly counter: number
  readonly pid: number
  readonly framework: string
  readonly frameworkVersion: string
  readonly runtimeVersion: string
  readonly engineVersion: string | null
  readonly sandbox: 'verified' | 'unverified'
}
export interface DesktopRenderer {
  readonly launch: string
  readonly revision: string
  readonly document: string
  readonly state: string
  readonly counter: number
  readonly nativeGlobalsAbsent: boolean
  readonly frameOpportunities: number
}
export interface DesktopObservation {
  readonly host: DesktopHost
  readonly renderer: DesktopRenderer
}
export interface DesktopLaunch {
  readonly origin: string
  readonly launch: string
  /** Host credentials are never sent to the page or included in URLs. */
  readonly hostToken: string
  readonly rendererToken: string
  /** Explicit local subframe fixture origin; never a main-frame navigation grant. */
  readonly workbenchOrigin?: string
}
export interface DesktopProbe {
  readonly configuration: DesktopLaunch
  readonly completion: Promise<DesktopObservation>
  requestIdle(milliseconds: number): void
  requestQuit(): void
  close(): Promise<void>
}
function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected object')
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('Unexpected fields')
  return value
}
function text(value: unknown, max = 256): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('Invalid text')
}
function integer(value: unknown, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw new Error('Invalid integer')
}
export function desktopHost(input: unknown): DesktopHost {
  const v = record(input, [
    'launch',
    'revision',
    'instance',
    'state',
    'counter',
    'pid',
    'framework',
    'frameworkVersion',
    'runtimeVersion',
    'engineVersion',
    'sandbox',
  ])
  for (const key of [
    'launch',
    'revision',
    'instance',
    'state',
    'framework',
    'frameworkVersion',
    'runtimeVersion',
  ])
    text(v[key])
  integer(v['counter'])
  integer(v['pid'], 1)
  if (v['engineVersion'] !== null) text(v['engineVersion'])
  if (v['sandbox'] !== 'verified' && v['sandbox'] !== 'unverified')
    throw new Error('Unknown sandbox evidence')
  return Object.freeze({ ...v }) as unknown as DesktopHost
}
export function desktopRenderer(input: unknown): DesktopRenderer {
  const v = record(input, [
    'launch',
    'revision',
    'document',
    'state',
    'counter',
    'nativeGlobalsAbsent',
    'frameOpportunities',
  ])
  for (const key of ['launch', 'revision', 'document', 'state']) text(v[key])
  integer(v['counter'])
  integer(v['frameOpportunities'])
  if (typeof v['nativeGlobalsAbsent'] !== 'boolean') throw new Error('Invalid renderer assertion')
  return Object.freeze({ ...v }) as unknown as DesktopRenderer
}
export function assertDesktopReplacement(
  before: DesktopObservation,
  after: DesktopObservation,
  revision: string
): void {
  const a = desktopHost(before.host),
    b = desktopHost(after.host)
  const ar = desktopRenderer(before.renderer),
    br = desktopRenderer(after.renderer)
  if (
    a.launch !== ar.launch ||
    b.launch !== br.launch ||
    a.revision !== ar.revision ||
    a.state !== ar.state ||
    a.counter !== ar.counter ||
    a.framework !== b.framework ||
    a.frameworkVersion !== b.frameworkVersion ||
    a.runtimeVersion !== b.runtimeVersion ||
    a.engineVersion !== b.engineVersion ||
    a.sandbox !== b.sandbox
  )
    throw new Error('Inconsistent desktop identity or configuration')
  if (
    revision === a.revision ||
    b.revision !== revision ||
    br.revision !== revision ||
    b.launch === a.launch ||
    b.instance === a.instance ||
    ar.document === br.document
  )
    throw new Error('No actual backend/document replacement')
  if (
    a.state !== b.state ||
    b.state !== br.state ||
    a.counter !== b.counter ||
    b.counter !== br.counter
  )
    throw new Error('Fixture disk state was not retained')
  if (
    !ar.nativeGlobalsAbsent ||
    !br.nativeGlobalsAbsent ||
    ar.frameOpportunities !== 2 ||
    br.frameOpportunities !== 2
  )
    throw new Error('Invalid renderer completion')
}
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
}
/** Exact origins/tokens distinguish fixture roles; they are not a production authenticator. */
export async function createDesktopProbe(options: {
  readonly revision: string
  readonly state: string
  readonly counter: number
  readonly framework: string
  readonly version: string
  readonly html: string
  readonly javascript: string
  readonly timeoutMs?: number
  /** Exact private workbench origin; absent in the focused protocol fixture. */
  readonly frameOrigin?: string
}): Promise<DesktopProbe> {
  for (const value of [options.revision, options.state, options.framework, options.version])
    text(value)
  integer(options.counter)
  const timeoutMs = options.timeoutMs ?? 20000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid probe deadline')
  if (
    typeof options.html !== 'string' ||
    typeof options.javascript !== 'string' ||
    options.html.length + options.javascript.length > 128 * 1024
  )
    throw new Error('Invalid fixture assets')
  let responseHeaders = headers
  if (options.frameOrigin !== undefined) {
    const frame = new URL(options.frameOrigin)
    if (
      frame.protocol !== 'http:' ||
      frame.hostname !== '127.0.0.1' ||
      frame.origin !== options.frameOrigin ||
      !frame.port
    )
      throw new Error('Invalid shared workbench origin')
    responseHeaders = {
      ...headers,
      'content-security-policy': headers['content-security-policy'] + '; frame-src ' + frame.origin,
    }
  }
  const launch = randomBytes(24).toString('hex'),
    hostToken = randomBytes(24).toString('hex'),
    rendererToken = randomBytes(24).toString('hex')
  let origin = '',
    host: DesktopHost | undefined,
    renderer: DesktopRenderer | undefined
  let disposed = false,
    failed = false,
    quit = false,
    completed = false
  let resolveCompletion!: (value: DesktopObservation) => void,
    rejectCompletion!: (error: Error) => void
  const completion = new Promise<DesktopObservation>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  void completion.catch(() => {})
  let commandWaiter: (() => void) | undefined
  let idleDuration: number | undefined
  function fail(error: Error): void {
    failed = true
    quit = true
    commandWaiter?.()
    if (!completed) rejectCompletion(error)
  }
  const timer = setTimeout(() => fail(new Error('Desktop renderer readiness deadline')), timeoutMs)
  const authorized = (request: Request, expected: string): boolean => {
    const actual = request.headers.get('x-bunly-probe-token')
    return (
      actual !== null &&
      /^[a-f0-9]{48}$/.test(actual) &&
      timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
  }
  const reply = (status: number, value: unknown) =>
    Response.json(value, { status, headers: responseHeaders })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 8192,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.origin !== origin || request.headers.get('host') !== new URL(origin).host)
        return reply(403, { error: 'HOST_DENIED' })
      if (disposed || failed) return reply(410, { error: 'CLOSED' })
      if (url.search) return reply(400, { error: 'NO_QUERY_PARAMETERS' })
      if (request.method === 'GET' && url.pathname === '/preflight')
        return new Response('<!doctype html><title>Sandbox preflight</title>', {
          headers: { ...responseHeaders, 'content-type': 'text/html; charset=utf-8' },
        })
      if (request.method === 'GET' && url.pathname === '/')
        return new Response(options.html, {
          headers: { ...responseHeaders, 'content-type': 'text/html; charset=utf-8' },
        })
      if (request.method === 'GET' && url.pathname === '/client.js')
        return new Response(options.javascript, {
          headers: { ...responseHeaders, 'content-type': 'text/javascript; charset=utf-8' },
        })
      const nativeRoute = url.pathname === '/host' || url.pathname === '/command'
      const pageRoute = url.pathname === '/descriptor' || url.pathname === '/renderer'
      if (!nativeRoute && !pageRoute) return reply(404, { error: 'NOT_FOUND' })
      if (!authorized(request, nativeRoute ? hostToken : rendererToken))
        return reply(403, { error: 'DENIED' })
      const suppliedOrigin = request.headers.get('origin')
      if (
        (nativeRoute && suppliedOrigin !== null) ||
        (pageRoute && suppliedOrigin !== null && suppliedOrigin !== origin) ||
        (url.pathname === '/renderer' && suppliedOrigin !== origin)
      )
        return reply(403, { error: 'ORIGIN_DENIED' })
      if (url.pathname === '/descriptor' && request.method === 'GET') {
        if (!host || quit) return reply(409, { error: 'NO_LIVE_HOST' })
        return reply(200, {
          launch,
          revision: host.revision,
          state: host.state,
          counter: host.counter,
        })
      }
      if (url.pathname === '/command' && request.method === 'GET') {
        if (!host) return reply(409, { error: 'NO_HOST' })
        if (commandWaiter) return reply(409, { error: 'WAITER_EXISTS' })
        if (!quit)
          await new Promise<void>((resolve) => {
            const abort = () => finish()
            const deadline = setTimeout(() => finish(), 500)
            function finish(): void {
              clearTimeout(deadline)
              request.signal.removeEventListener('abort', abort)
              commandWaiter = undefined
              resolve()
            }
            commandWaiter = finish
            request.signal.addEventListener('abort', abort, { once: true })
            if (request.signal.aborted || quit) finish()
          })
        if (!quit && !disposed && !failed && idleDuration !== undefined) {
          const milliseconds = idleDuration
          idleDuration = undefined
          return reply(200, { command: 'observe-idle', milliseconds })
        }
        return reply(200, { command: quit || disposed || failed ? 'quit' : 'continue' })
      }
      if (request.method !== 'POST' || !['/host', '/renderer'].includes(url.pathname))
        return reply(405, { error: 'METHOD_DENIED' })
      if (request.headers.get('content-type') !== 'application/json')
        return reply(415, { error: 'JSON_REQUIRED' })
      try {
        const raw = await request.text()
        if (Buffer.byteLength(raw) > 8192) return reply(413, { error: 'TOO_LARGE' })
        if (disposed || failed || quit) return reply(410, { error: 'CLOSED' })
        if (url.pathname === '/host') {
          if (host) return reply(409, { error: 'ALREADY_REGISTERED' })
          const next = desktopHost(JSON.parse(raw))
          if (
            next.launch !== launch ||
            next.revision !== options.revision ||
            next.state !== options.state ||
            next.counter !== options.counter ||
            next.framework !== options.framework ||
            next.frameworkVersion !== options.version
          )
            throw new Error('Host mismatch')
          host = next
        } else {
          if (!host || renderer) return reply(409, { error: 'NO_HOST_OR_DUPLICATE' })
          const next = desktopRenderer(JSON.parse(raw))
          if (
            next.launch !== launch ||
            next.revision !== host.revision ||
            next.state !== host.state ||
            next.counter !== host.counter ||
            !next.nativeGlobalsAbsent ||
            next.frameOpportunities !== 2
          )
            throw new Error('Renderer mismatch')
          renderer = next
          completed = true
          clearTimeout(timer)
          resolveCompletion(Object.freeze({ host, renderer }))
        }
        return reply(202, { accepted: true })
      } catch {
        return reply(400, { error: 'INVALID_REPORT' })
      }
    },
  })
  origin = server.url.origin
  return {
    configuration: Object.freeze({ origin, launch, hostToken, rendererToken }),
    completion,
    requestIdle(milliseconds) {
      if (
        !completed ||
        disposed ||
        failed ||
        quit ||
        idleDuration !== undefined ||
        !Number.isSafeInteger(milliseconds) ||
        milliseconds < 250 ||
        milliseconds > 10000
      )
        throw new Error('Invalid idle observation request')
      idleDuration = milliseconds
      commandWaiter?.()
    },
    requestQuit() {
      quit = true
      commandWaiter?.()
    },
    async close() {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      quit = true
      commandWaiter?.()
      if (!completed) rejectCompletion(new Error('Desktop probe closed before completion'))
      await server.stop(true)
    },
  }
}

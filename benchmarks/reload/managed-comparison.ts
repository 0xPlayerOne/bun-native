/** A shared end-user outcome, with deliberately distinct native lifecycle semantics. */
import assert from 'node:assert/strict'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { terminalChunk, checksum } from '../fixtures/data.ts'
import { quantile } from '../lib/statistics.ts'

export const MANAGED_COMPARISON_PROFILE = 'managed-edit-outcome-v1'
export const COMPARISON_PLAN = Object.freeze({ warmups: 1, measurements: 3, edits: 4, lines: 32 })
export const COMPARISON_FORM = 'unfinished browser form: keep this text across backend edits'
export type ComparisonFramework = 'bunly' | 'electrobun' | 'mirin'
export type ComparisonPersistence = 'retained-native-document' | 'relaunch-and-browser-storage'
export interface ComparisonHost {
  readonly revision: number
  readonly instance: string
  readonly pid: number
  readonly framework: ComparisonFramework
  readonly version: string
  readonly runtimeVersion: string
  readonly identities: {
    readonly window: string
    readonly view: string
    readonly session: string
  } | null
}
export interface ComparisonRenderer {
  readonly revision: number
  readonly document: string
  readonly form: string
  readonly restored: boolean
  readonly bytes: number
  readonly checksum: number
  readonly lastSequence: number
  readonly frameOpportunities: number
  readonly nativeGlobalsAbsent: boolean
}
export interface ComparisonObservation {
  readonly host: ComparisonHost
  readonly renderer: ComparisonRenderer
}
export interface ComparisonRow {
  readonly revision: number
  readonly role: 'initial' | 'warmup' | 'measurement'
  readonly status: 'passed' | 'failed' | 'not-executed'
  readonly elapsedMs: number | null
  readonly observation: ComparisonObservation | null
  readonly failure: string | null
}
export const COMPARISON_VERSIONS = Object.freeze({
  bunly: '0.1.0-dev.0',
  electrobun: '2.0.3-beta.26',
  mirin: '0.1.0-alpha.26',
})

export function comparisonChunk(revision: number): Uint8Array {
  assert.ok(Number.isSafeInteger(revision) && revision >= 0 && revision <= COMPARISON_PLAN.edits)
  const chunks = Array.from({ length: COMPARISON_PLAN.lines }, (_, index) =>
    terminalChunk(revision * COMPARISON_PLAN.lines + index)
  )
  return Buffer.concat(chunks)
}
export function comparisonTranscript(revision: number): Uint8Array {
  comparisonChunk(revision)
  return Buffer.concat(Array.from({ length: revision + 1 }, (_, index) => comparisonChunk(index)))
}
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
const fields = (value: Record<string, unknown>, names: readonly string[]) =>
  assert.deepEqual(Object.keys(value).sort(), [...names].sort())
const uuid = (value: unknown) =>
  assert.ok(
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  )
export function comparisonHost(
  input: unknown,
  framework: ComparisonFramework,
  revision: number,
  options: { allowRedactedRuntime?: boolean } = {}
): ComparisonHost {
  const value = object(input)
  fields(value, [
    'revision',
    'instance',
    'pid',
    'framework',
    'version',
    'runtimeVersion',
    'identities',
  ])
  assert.equal(
    value['revision'],
    revision,
    'Changed backend handler did not answer the expected revision'
  )
  assert.equal(value['framework'], framework)
  assert.equal(value['version'], COMPARISON_VERSIONS[framework])
  assert.ok(
    (typeof value['runtimeVersion'] === 'string' &&
      /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value['runtimeVersion'])) ||
      (options.allowRedactedRuntime === true && value['runtimeVersion'] === 'VERSION_REDACTED')
  )
  assert.ok(Number.isSafeInteger(value['pid']) && Number(value['pid']) > 0)
  uuid(value['instance'])
  if (framework === 'bunly') {
    const identities = object(value['identities'])
    fields(identities, ['window', 'view', 'session'])
    for (const identity of Object.values(identities)) uuid(identity)
  } else
    assert.equal(
      value['identities'],
      null,
      'Reference native identity is not inspected by this profile'
    )
  return value as unknown as ComparisonHost
}
export function comparisonRenderer(input: unknown, revision: number): ComparisonRenderer {
  const value = object(input)
  fields(value, [
    'revision',
    'document',
    'form',
    'restored',
    'bytes',
    'checksum',
    'lastSequence',
    'frameOpportunities',
    'nativeGlobalsAbsent',
  ])
  assert.equal(value['revision'], revision)
  uuid(value['document'])
  assert.equal(value['form'], COMPARISON_FORM, 'Browser-owned unfinished form was lost')
  assert.equal(typeof value['restored'], 'boolean')
  const expected = comparisonTranscript(revision)
  assert.equal(
    value['bytes'],
    expected.byteLength,
    'Numbered transcript bytes were lost or duplicated'
  )
  assert.equal(value['checksum'], checksum(expected), 'Numbered transcript order/content changed')
  assert.equal(value['lastSequence'], (revision + 1) * COMPARISON_PLAN.lines - 1)
  assert.equal(value['frameOpportunities'], 2)
  assert.equal(value['nativeGlobalsAbsent'], true)
  return value as unknown as ComparisonRenderer
}
export function acceptComparisonRows(
  framework: ComparisonFramework,
  rows: readonly ComparisonRow[],
  options: { allowRedactedRuntime?: boolean } = {}
) {
  assert.equal(
    rows.length,
    COMPARISON_PLAN.edits + 1,
    'Fixed plan is incomplete; no retry or discarded warmup'
  )
  const persistence: ComparisonPersistence =
    framework === 'bunly' ? 'retained-native-document' : 'relaunch-and-browser-storage'
  let previous: ComparisonObservation | undefined
  const durations: number[] = []
  for (const [revision, row] of rows.entries()) {
    assert.equal(row.revision, revision)
    assert.equal(
      row.role,
      revision === 0 ? 'initial' : revision <= COMPARISON_PLAN.warmups ? 'warmup' : 'measurement'
    )
    assert.equal(row.status, 'passed', 'Every declared row, including warmup, must pass')
    assert.equal(row.failure, null)
    assert.ok(
      typeof row.elapsedMs === 'number' &&
        Number.isFinite(row.elapsedMs) &&
        row.elapsedMs >= 0 &&
        row.elapsedMs <= 300_000
    )
    assert.ok(row.observation)
    const current = {
      host: comparisonHost(row.observation.host, framework, revision, options),
      renderer: comparisonRenderer(row.observation.renderer, revision),
    }
    if (!previous)
      assert.equal(current.renderer.restored, false, 'Initial browser storage must be empty')
    else {
      assert.equal(
        current.host.runtimeVersion,
        previous.host.runtimeVersion,
        'Runtime changed during fixed plan'
      )
      if (framework === 'bunly') {
        assert.equal(current.host.instance, previous.host.instance, 'Stable backend host restarted')
        assert.equal(current.host.pid, previous.host.pid)
        assert.deepEqual(current.host.identities, previous.host.identities)
        assert.equal(
          current.renderer.document,
          previous.renderer.document,
          'Native document was replaced'
        )
        assert.equal(current.renderer.restored, false, 'In-memory browser state was reconstructed')
      } else {
        assert.notEqual(
          current.host.instance,
          previous.host.instance,
          'Reference backend did not restart'
        )
        assert.notEqual(
          current.renderer.document,
          previous.renderer.document,
          'Reference page was not relaunched'
        )
        assert.equal(
          current.renderer.restored,
          true,
          'Reference browser did not restore its own prior state'
        )
      }
    }
    if (row.role === 'measurement') durations.push(row.elapsedMs)
    previous = current
  }
  return {
    passed: true,
    persistence,
    count: durations.length,
    medianMs: quantile(durations, 0.5),
    p95Ms: quantile(durations, 0.95),
    performanceEligible: false,
    timingMeaning:
      'source write through changed backend response, form/transcript verification, xterm callback and two animation frames; correlated fixed-order smoke samples',
  }
}

export interface ComparisonLaunch {
  readonly origin: string
  readonly hostToken: string
  readonly rendererToken: string
}
export async function createComparisonProbe(options: {
  readonly framework: ComparisonFramework
  readonly html: string
  readonly javascript: string
  readonly terminalJs: string
  readonly terminalCss: string
  readonly timeoutMs?: number
}) {
  assert.ok(Object.hasOwn(COMPARISON_VERSIONS, options.framework))
  const timeoutMs = options.timeoutMs ?? 300_000
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000)
  for (const asset of [options.html, options.javascript, options.terminalJs, options.terminalCss])
    assert.ok(typeof asset === 'string' && asset.length > 0 && asset.length <= 2 * 1024 * 1024)
  const hostToken = randomBytes(24).toString('hex'),
    rendererToken = randomBytes(24).toString('hex'),
    storageKey = randomBytes(24).toString('hex')
  let origin = '',
    expected = -1,
    host: ComparisonHost | undefined,
    closed = false,
    quit = false
  let command: { action: 'edit'; revision: number } | undefined
  let pending:
    | {
        resolve(value: ComparisonObservation): void
        reject(error: Error): void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  }
  const reply = (status: number, value: unknown) => Response.json(value, { status, headers })
  const fail = (error: Error) => {
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      pending = undefined
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 4096,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.origin !== origin || request.headers.get('host') !== new URL(origin).host)
        return reply(403, { error: 'HOST_DENIED' })
      if (closed) return reply(410, { error: 'CLOSED' })
      if (url.search) return reply(400, { error: 'NO_QUERY' })
      const assets: Record<string, readonly [string, string]> = {
        '/': [options.html, 'text/html'],
        '/client.js': [options.javascript, 'text/javascript'],
        '/xterm.js': [options.terminalJs, 'text/javascript'],
        '/xterm.css': [options.terminalCss, 'text/css'],
      }
      const asset = assets[url.pathname]
      if (request.method === 'GET' && asset)
        return new Response(asset[0], { headers: { ...headers, 'content-type': asset[1] } })
      const native = url.pathname === '/host' || url.pathname === '/command'
      const renderer = ['/descriptor', '/bytes', '/renderer'].includes(url.pathname)
      if (!native && !renderer) return reply(404, { error: 'NOT_FOUND' })
      const token = request.headers.get('x-bunly-probe-token'),
        intended = native ? hostToken : rendererToken
      if (
        !token ||
        !/^[a-f0-9]{48}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(intended))
      )
        return reply(403, { error: 'DENIED' })
      const suppliedOrigin = request.headers.get('origin')
      if (
        (native && suppliedOrigin !== null) ||
        (renderer && suppliedOrigin !== null && suppliedOrigin !== origin) ||
        (url.pathname === '/renderer' && suppliedOrigin !== origin)
      )
        return reply(403, { error: 'ORIGIN_DENIED' })
      try {
        if (url.pathname === '/host' && request.method === 'POST') {
          assert.ok(pending && !host, 'Duplicate or unsolicited backend acknowledgment')
          host = comparisonHost(await request.json(), options.framework, expected)
          return reply(200, { accepted: true })
        }
        if (url.pathname === '/command' && request.method === 'GET') {
          if (quit) return reply(200, { action: 'quit' })
          const value = command
          command = undefined
          return reply(200, value ?? { action: 'wait' })
        }
        if (url.pathname === '/descriptor' && request.method === 'GET')
          return reply(
            host ? 200 : 425,
            host
              ? {
                  revision: host.revision,
                  storageKey,
                  initialForm: host.revision === 0 ? COMPARISON_FORM : null,
                }
              : { action: 'wait' }
          )
        if (url.pathname === '/bytes' && request.method === 'GET') {
          if (!host) return reply(425, { action: 'wait' })
          return new Response(Buffer.from(comparisonChunk(host.revision)), {
            headers: { ...headers, 'content-type': 'application/octet-stream' },
          })
        }
        if (url.pathname === '/renderer' && request.method === 'POST') {
          assert.ok(host && pending, 'Unsolicited renderer completion')
          const value = comparisonRenderer(await request.json(), expected)
          clearTimeout(pending.timer)
          pending.resolve({ host, renderer: value })
          pending = undefined
          return reply(200, { accepted: true })
        }
        return reply(405, { error: 'METHOD_DENIED' })
      } catch {
        fail(new Error('Comparison acknowledgment failed validation'))
        return reply(422, { error: 'INVALID_COMPLETION' })
      }
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  return {
    configuration: Object.freeze({ origin, hostToken, rendererToken }),
    expect(revision: number): Promise<ComparisonObservation> {
      assert.equal(closed, false)
      assert.equal(pending, undefined)
      assert.equal(revision, expected + 1)
      comparisonChunk(revision)
      expected = revision
      host = undefined
      quit = false
      const promise = new Promise<ComparisonObservation>((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => fail(new Error('Comparison renderer deadline')), timeoutMs),
        }
      })
      void promise.catch(() => {})
      return promise
    },
    edit(revision: number) {
      assert.ok(pending && revision === expected && !command)
      command = { action: 'edit', revision }
    },
    resume() {
      assert.ok(pending && !closed)
      quit = false
    },
    quit() {
      quit = true
    },
    async close() {
      if (closed) return
      closed = true
      fail(new Error('Comparison probe closed'))
      await server.stop(true)
    },
  }
}

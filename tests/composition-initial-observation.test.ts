import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { gunzipSync } from 'node:zlib'
import { test } from 'bun:test'
import {
  INITIAL_OBSERVATION_LIMIT,
  parseInitialObservation,
  requireInitialObservation,
  type InitialObservation,
  type InitialObservationCollector,
  type InitialObservationEvent,
} from '../examples/view-composition/initial-observation.ts'
import { InitialObservationRequests } from '../examples/view-composition/initial-observation-host.ts'
import { desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import { decodeExportedNativeReport } from '../benchmarks/lib/exported-native-evidence.ts'

const script = readFileSync(
  new URL('../examples/view-composition/public/initial-observation.js', import.meta.url),
  'utf8'
)
const instance = '00000000-0000-4000-8000-000000000001'

/** Executes the actual classic script against controlled event sources. These
 * unit observations are not browser, native focus or qualification evidence.
 */
function browser(url = 'app://ui/index.html?pane=overlay&interaction=2') {
  const state = { visibility: 'hidden', focused: false }
  const windowEvents = new Map<string, Set<(event: { type: string; isTrusted: boolean }) => void>>()
  const documentEvents = new Map<
    string,
    Set<(event: { type: string; isTrusted: boolean }) => void>
  >()
  type Events = typeof windowEvents
  const add =
    (events: Events) =>
    (name: string, listener: (event: { type: string; isTrusted: boolean }) => void) => {
      if (!events.has(name)) events.set(name, new Set())
      events.get(name)!.add(listener)
    }
  const remove =
    (events: Events) =>
    (name: string, listener: (event: { type: string; isTrusted: boolean }) => void) => {
      events.get(name)?.delete(listener)
    }
  const context = {
    location: { href: url },
    URL,
    crypto: { randomUUID: () => instance },
    addEventListener: add(windowEvents),
    removeEventListener: remove(windowEvents),
    document: {
      get visibilityState() {
        return state.visibility
      },
      hasFocus: () => state.focused,
      addEventListener: add(documentEvents),
      removeEventListener: remove(documentEvents),
    },
    __bunlyCompositionInitialObservation: undefined as InitialObservationCollector | undefined,
  }
  runInNewContext(script, context)
  return {
    state,
    collector: context.__bunlyCompositionInitialObservation,
    emit(type: 'focus' | 'blur' | 'visibilitychange' | 'pagehide', trusted = true) {
      const events = type === 'visibilitychange' ? documentEvents : windowEvents
      for (const listener of events.get(type) ?? []) listener({ type, isTrusted: trusted })
    },
    listeners: () =>
      [...windowEvents.values(), ...documentEvents.values()].reduce(
        (n, values) => n + values.size,
        0
      ),
  }
}

function observed(
  event: InitialObservationEvent['event'],
  focused = false,
  visibility: 'hidden' | 'visible' = 'hidden'
): InitialObservationEvent {
  return {
    event,
    visibility,
    focused,
    trusted: ['focus', 'blur', 'visibilitychange'].includes(event) ? true : null,
  }
}
function history(events: readonly InitialObservationEvent[]): InitialObservation {
  return { pane: 'overlay', instance, phase: 'before-show', events, overflow: false }
}
const quiet = () =>
  history([observed('initial'), observed('after-create'), observed('before-show')])

test('blocking script records initial state and transitions before the module/RPC client exists', () => {
  const page = browser()
  page.state.visibility = 'visible'
  page.emit('visibilitychange')
  page.state.focused = true
  page.emit('focus')
  page.state.focused = false
  page.emit('blur')
  page.state.visibility = 'hidden'
  page.emit('visibilitychange')
  const initial = parseInitialObservation(page.collector!.snapshot('initial'))
  assert.deepEqual(
    initial.events.map((event) => event.event),
    ['initial', 'visibilitychange', 'focus', 'blur', 'visibilitychange']
  )
  assert.equal(initial.events[0]!.visibility, 'hidden')
  page.collector!.snapshot('after-create')
  const final = parseInitialObservation(page.collector!.snapshot('before-show'))
  assert.equal(final.events.at(-1)!.visibility, 'hidden')
  assert.throws(() => requireInitialObservation(final), /exposed or received focus/)
  assert.equal(page.listeners(), 0)
  assert.throws(() => page.collector!.snapshot('before-show'), /checkpoint/)

  const html = readFileSync(
    new URL('../examples/view-composition/public/index.html', import.meta.url),
    'utf8'
  )
  assert.ok(
    html.indexOf('<script src="/initial-observation.js"></script>') <
      html.indexOf('<script type="module" src="/client.js"></script>')
  )
  assert.equal(/<script[^>]*(?:initial-observation)[^>]*(?:async|defer|module)/.test(html), false)
  const resources = readFileSync(
    new URL('../native/cef-host/src/resources.rs', import.meta.url),
    'utf8'
  )
  assert.match(resources, /script-src 'self';/)
  assert.equal(resources.includes("'unsafe-inline'"), false)
})

test('ordinary composition installs no early observers and exact v2 mode carries no authority', () => {
  for (const url of [
    'app://ui/index.html?pane=left',
    'app://ui/index.html?pane=overlay&interaction=1',
    'app://ui/index.html?pane=overlay&interaction=other',
  ]) {
    const page = browser(url)
    assert.equal(page.collector, undefined)
    assert.equal(page.listeners(), 0)
  }
  for (const url of [
    'https://example.test/index.html?pane=overlay&interaction=2',
    'app://ui/other.html?pane=overlay&interaction=2',
    'app://ui/index.html?pane=overlay&interaction=2&interaction=2',
    'app://ui/index.html?pane=overlay&pane=right&interaction=2',
    'app://ui/index.html?pane=overlay&interaction=2&capability=grant',
  ])
    assert.throws(() => browser(url), /fixture mode/)
})

test('collector uses a sticky finite bound and detaches on page exit', () => {
  const page = browser()
  page.collector!.snapshot('initial')
  for (let i = 0; i < INITIAL_OBSERVATION_LIMIT + 2; i++) page.emit('visibilitychange')
  const sample = page.collector!.snapshot('after-create')
  assert.equal(sample.events.length, INITIAL_OBSERVATION_LIMIT)
  assert.equal(sample.overflow, true)
  assert.throws(() => requireInitialObservation(sample))
  page.emit('pagehide')
  assert.equal(page.listeners(), 0)
  assert.throws(() => page.collector!.snapshot('before-show'), /checkpoint/)
})

test('strict initial histories reject missing, untrusted, malformed and overflowing evidence', () => {
  assert.deepEqual(requireInitialObservation(quiet()), quiet())
  for (const value of [
    null,
    { ...quiet(), extra: true },
    { ...quiet(), events: [] },
    { ...quiet(), overflow: true },
    { ...quiet(), instance: 'unbound' },
    { ...quiet(), phase: 'initial' },
    history([observed('after-create'), observed('before-show')]),
    history([
      observed('initial'),
      observed('initial'),
      observed('after-create'),
      observed('before-show'),
    ]),
    history([
      observed('initial'),
      observed('before-create'),
      observed('after-create'),
      observed('before-show'),
    ]),
    history([
      observed('initial'),
      { ...observed('focus'), trusted: false },
      observed('after-create'),
      observed('before-show'),
    ]),
    history([
      observed('initial'),
      { ...observed('focus'), event: ['focus'] } as unknown as InitialObservationEvent,
      observed('after-create'),
      observed('before-show'),
    ]),
    history([
      observed('initial'),
      { ...observed('visibilitychange'), focused: 'false' } as unknown as InitialObservationEvent,
      observed('after-create'),
      observed('before-show'),
    ]),
    history([
      observed('initial'),
      ...Array.from({ length: INITIAL_OBSERVATION_LIMIT }, () => observed('visibilitychange')),
      observed('after-create'),
      observed('before-show'),
    ]),
  ])
    assert.throws(() => requireInitialObservation(value))
})

function context(viewId = 'view-overlay') {
  const controller = new AbortController()
  return {
    controller,
    context: {
      signal: controller.signal,
      identity: {
        viewId,
        documentId: 'document-overlay',
        frameId: 'frame-1',
        generation: 1,
        origin: 'app://ui',
      },
    },
  }
}

test('host checkpoints retain exact document identity and an append-only early history', async () => {
  const requests = new InitialObservationRequests()
  const owner = context()
  const start = { ...quiet(), phase: 'initial' as const, events: [observed('initial')] }
  const first = requests.receive(start, owner.context)
  const after = requests.checkpoint('overlay', 'after-create')
  assert.deepEqual(await first, { next: 'after-create' })
  const nextHistory = {
    ...start,
    phase: 'after-create' as const,
    events: [...start.events, observed('after-create')],
  }
  const second = requests.receive(nextHistory, owner.context)
  assert.deepEqual(await after, nextHistory)
  const beforeShow = requests.checkpoint('overlay', 'before-show')
  assert.deepEqual(await second, { next: 'before-show' })
  assert.deepEqual(await requests.receive(quiet(), owner.context), { next: 'stop' })
  assert.deepEqual(await beforeShow, quiet())
  assert.equal(requests.observations()['overlay']!.documentId, 'document-overlay')
  assert.throws(() => requests.receive(quiet(), owner.context), /checkpoint changed/)
  requests.close()
})

test('replaced identity, rewritten history and document cancellation settle host waiters', async () => {
  for (const changed of ['identity', 'history'] as const) {
    const requests = new InitialObservationRequests()
    const owner = context()
    const initial = { ...quiet(), phase: 'initial' as const, events: [observed('initial')] }
    const first = requests.receive(initial, owner.context)
    const pending = requests.checkpoint('overlay', 'after-create')
    void pending.catch(() => {})
    await first
    const next = {
      ...initial,
      phase: 'after-create' as const,
      events: [observed('initial', changed === 'history'), observed('after-create')],
    }
    const identity =
      changed === 'identity'
        ? { ...owner.context.identity, documentId: 'replaced' }
        : owner.context.identity
    assert.throws(
      () => requests.receive(next, { ...owner.context, identity }),
      /document, history or checkpoint changed/
    )
    requests.close(new Error('fixture stopped'))
    await assert.rejects(pending, /fixture stopped/)
  }
  const requests = new InitialObservationRequests()
  const owner = context()
  const response = requests.receive(
    { ...quiet(), phase: 'initial', events: [observed('initial')] },
    owner.context
  )
  owner.controller.abort(new Error('document retired'))
  await assert.rejects(response, /document retired/)
  assert.throws(() => requests.checkpoint('overlay', 'after-create'), /document retired/)
})

test('retained six-report v1 cohort keeps one acceptance and all five failures', () => {
  const base = new URL('../evidence/m7-composition-interactions/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8')) as {
    runs: { archive: string; passed: boolean }[]
  }
  let accepted = 0,
    rejected = 0
  for (const row of manifest.runs) {
    const report = decodeExportedNativeReport(
      JSON.parse(gunzipSync(readFileSync(new URL(row.archive, base))).toString('utf8'))
    )
    const profile = desktopReportProfile(report['profile'])
    assert.equal(profile.profile, 'native-composition-interactions-v1')
    if (row.passed) {
      assert.deepEqual(profile.acceptReport(report), report['acceptance'])
      accepted++
    } else {
      assert.throws(() => profile.acceptReport(report))
      rejected++
    }
  }
  assert.equal(accepted, 1)
  assert.equal(rejected, 5)
})

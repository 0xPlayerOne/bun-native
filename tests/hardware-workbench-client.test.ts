import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import type { PreviewName, WorkbenchSnapshot } from '../examples/hardware-workbench/contract.ts'

let source: Promise<string> | undefined
function browserClient(): Promise<string> {
  return (source ??= (async () => {
    const entry = fileURLToPath(
      new URL('../examples/hardware-workbench/client.ts', import.meta.url)
    )
    // Run the actual renderer's scheduling and event handlers. Only the native
    // bridge edge is replaced; native authority is covered by the workbench suite.
    const shims: Readonly<Record<string, string>> = {
      '../../packages/client/src/rpc.ts': `export class RpcClient {
        call(...args) { return globalThis.fixture.call(...args) }
        close() { globalThis.fixture.close() }
      }`,
      '../../packages/client/src/cef-rpc.ts':
        'export const waitForCefRpcTransport = async () => ({})',
    }
    const built = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'esm',
      plugins: [
        {
          name: 'hardware-workbench-native-edge',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) =>
              args.importer === entry && Object.hasOwn(shims, args.path)
                ? { path: args.path, namespace: 'fixture-edge' }
                : undefined
            )
            build.onLoad({ filter: /.*/, namespace: 'fixture-edge' }, (args) => ({
              contents: shims[args.path]!,
              loader: 'js',
            }))
          },
        },
      ],
    })
    assert.ok(built.success, String(built.logs))
    return built.outputs[0]!.text()
  })())
}

class Element extends EventTarget {
  id = ''
  value = ''
  textContent = ''
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly children: Element[] = []
  hidden = false
  append(...children: Element[]): void {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]): void {
    this.children.splice(0, this.children.length, ...children)
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  focus(): void {}
  click(): void {
    this.dispatchEvent(new Event('click'))
  }
}

class PaneForm extends Element {
  readonly values = new Map<string, string>([
    ['visible', 'on'],
    ['focusable', 'on'],
    ['clip', 'none'],
    ['width', '400'],
    ['height', '500'],
  ])
  readonly range = new Element()
  readonly output = new Element()
  constructor(pane: PreviewName) {
    super()
    this.dataset['pane'] = pane
    this.range.id = `${pane}-width`
    this.range.value = '400'
  }
  querySelectorAll(): Element[] {
    return [this.range]
  }
  querySelector(): Element {
    return this.output
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

async function startClient(surface: 'controls' | 'overlay', deferCalls = false) {
  const elements = new Map<string, Element>()
  const element = (selector: string) => {
    let value = elements.get(selector)
    if (!value) elements.set(selector, (value = new Element()))
    return value
  }
  element('#connection').textContent = 'Connecting to native application…'
  const calls: { method: string; input: unknown }[] = []
  const pending: {
    method: string
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }[] = []
  let peakPending = 0
  const forms = { left: new PaneForm('left'), right: new PaneForm('right') }
  const focus = element('#focus-left')
  focus.dataset['command'] = JSON.stringify({ action: 'focus', pane: 'left' })
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const page = new EventTarget()
  let nextTimer = 0,
    closes = 0
  const snapshot: WorkbenchSnapshot = {
    phase: 'ready',
    heartbeat: 1,
    observedAtMs: 1000,
    window: null,
    panes: [],
    overlay: null,
    events: [],
    discardedEvents: 0,
  }
  runInNewContext(await browserClient(), {
    fixture: {
      async call(method: string, input: unknown) {
        calls.push({ method, input })
        assert.ok(method === 'snapshot' || method === 'command')
        if (deferCalls) {
          const result = Promise.withResolvers<unknown>()
          pending.push({ method, resolve: result.resolve, reject: result.reject })
          peakPending = Math.max(peakPending, pending.length)
          return result.promise
        }
        return method === 'snapshot' ? snapshot : null
      },
      close() {
        closes++
      },
    },
    document: {
      documentElement: { dataset: { surface } },
      querySelector: (selector: string) =>
        surface === 'overlay' && ['#native-observation', '#native-events'].includes(selector)
          ? null
          : element(selector),
      querySelectorAll: (selector: string) =>
        selector === 'form[data-pane]' ? Object.values(forms) : [focus],
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
    },
    FormData: class {
      constructor(private readonly form: PaneForm) {}
      get(name: string): string | null {
        return this.form.values.get(name) ?? null
      }
    },
    setTimeout(callback: () => void, delay: number) {
      const timer = ++nextTimer
      timers.set(timer, { callback, delay })
      return timer
    },
    clearTimeout(timer: number) {
      timers.delete(timer)
    },
    addEventListener: page.addEventListener.bind(page),
  })
  await turn()
  return {
    element,
    calls,
    timers,
    pending,
    get peakPending() {
      return peakPending
    },
    get closes() {
      return closes
    },
    resize(pane: PreviewName, width: number) {
      const form = forms[pane]
      form.values.set('width', String(width))
      form.range.value = String(width)
      form.range.dispatchEvent(new Event('input'))
    },
    async settle(error?: Error) {
      const request = pending.shift()
      assert.ok(request, 'A deferred native request must be pending')
      if (error) request.reject(error)
      else request.resolve(request.method === 'snapshot' ? snapshot : null)
      await turn()
    },
    async tick(delay = 1500) {
      // A callback can schedule another timer; one tick consumes only the original set.
      const due = [...timers]
      for (const [id, timer] of due) {
        if (timer.delay === delay) {
          timers.delete(id)
          timer.callback()
        }
      }
      await turn()
    },
    hide() {
      page.dispatchEvent(new Event('pagehide'))
    },
  }
}

test('overlay connects and dismisses without unused snapshot requests or polling timers', async () => {
  const client = await startClient('overlay')
  try {
    assert.match(client.element('#connection').textContent, /^Connected\./)
    assert.deepEqual(client.calls, [])
    assert.equal(client.timers.size, 0)
    client.element('#dismiss-overlay').click()
    await turn()
    assert.deepEqual(JSON.parse(JSON.stringify(client.calls)), [
      { method: 'command', input: { action: 'dismiss-overlay' } },
    ])
    assert.match(client.element('#connection').textContent, /Native command acknowledged/)
    assert.equal(client.timers.size, 0)
  } finally {
    client.hide()
  }
  assert.equal(client.closes, 1)
  client.element('#dismiss-overlay').click()
  await turn()
  assert.equal(client.calls.length, 1, 'A retired overlay cannot send another command')
})

test('range presentations wait for native observations and retain only the latest value per pane', async () => {
  const client = await startClient('controls', true)
  try {
    for (const [pane, width] of [
      ['left', 410],
      ['left', 420],
      ['right', 430],
    ] as const) {
      client.resize(pane, width)
      await client.tick(160)
    }
    client.element('#focus-left').click()
    assert.equal(client.calls.length, 1, 'Neither resize nor focus may overlap the snapshot')
    await client.settle()
    assert.equal(client.calls.length, 2)
    for (let width = 500; width <= 550; width++) {
      client.resize('left', width)
      client.resize('right', width + 10)
      await client.tick(160)
    }
    assert.equal(client.calls.length, 2, 'Resize bursts do not start concurrent commands')
    await client.settle()
    await client.settle()
    await client.settle()
    const presentations = JSON.parse(JSON.stringify(client.calls.slice(1, -1))).map(
      (call: { method: string; input: { action: string; pane: string; width: number } }) => [
        call.method,
        call.input.action,
        call.input.pane,
        call.input.width,
      ]
    )
    assert.deepEqual(presentations, [
      ['command', 'present', 'left', 420],
      ['command', 'present', 'right', 560],
      ['command', 'present', 'left', 550],
    ])
    assert.equal(client.calls.at(-1)?.method, 'snapshot')
    assert.equal(client.peakPending, 1)
    await client.settle()
    assert.equal(client.pending.length, 0, 'The earlier focus action was not queued or replayed')
    client.element('#focus-left').click()
    await turn()
    assert.deepEqual(JSON.parse(JSON.stringify(client.calls.at(-1)?.input)), {
      action: 'focus',
      pane: 'left',
    })
    await client.settle()
    await client.settle()
  } finally {
    client.hide()
  }
})

test('a failed presentation is not retried and does not discard a newer pending value', async () => {
  const client = await startClient('controls', true)
  try {
    await client.settle()
    client.resize('left', 450)
    await client.tick(160)
    client.resize('left', 520)
    await client.tick(160)
    await client.settle(new Error('Native placement failed'))
    await client.settle()
    assert.deepEqual(
      JSON.parse(JSON.stringify(client.calls.filter((call) => call.method === 'command'))).map(
        (call: { input: { width: number } }) => call.input.width
      ),
      [450, 520]
    )
    assert.equal(client.calls.at(-1)?.method, 'snapshot')
    assert.equal(client.peakPending, 1)
    await client.settle()
  } finally {
    client.hide()
  }
})

test('pagehide discards queued presentations and late read or command receipts cannot dispatch them', async () => {
  for (const operation of ['snapshot', 'command'] as const) {
    const client = await startClient('controls', true)
    if (operation === 'command') {
      await client.settle()
      client.resize('left', 450)
      await client.tick(160)
    }
    client.resize('left', 520)
    client.resize('right', 560)
    await client.tick(160)
    client.resize('left', 600)
    const queuedTimers = [...client.timers.values()].map((timer) => timer.callback)
    const before = client.calls.length
    client.hide()
    for (const callback of queuedTimers) callback()
    await client.settle()
    assert.equal(client.calls.length, before)
    assert.equal(client.pending.length, 0)
    assert.equal(client.timers.size, 0)
    assert.equal(client.closes, 1)
  }
})

test('controls retain periodic and explicit observations, pause, and pagehide cleanup', async () => {
  const client = await startClient('controls')
  try {
    assert.deepEqual(
      client.calls.map((call) => call.method),
      ['snapshot']
    )
    assert.match(client.element('#native-observation').textContent, /"backendHeartbeat": 1/)
    assert.equal(client.timers.size, 1)
    await client.tick()
    assert.equal(client.calls.length, 2)
    client.element('#pause-observations').click()
    assert.equal(client.element('#pause-observations').attributes.get('aria-pressed'), 'true')
    await client.tick()
    assert.equal(client.calls.length, 2, 'Paused periodic reads stay paused')
    client.element('#refresh-observations').click()
    await turn()
    assert.equal(client.calls.length, 3, 'An explicit read remains available while paused')
    client.element('#pause-observations').click()
    await client.tick()
    assert.equal(client.calls.length, 4)
    const queued = [...client.timers.values()][0]!.callback
    client.hide()
    queued()
    await turn()
    assert.equal(client.calls.length, 4, 'A late timer cannot read after pagehide')
    assert.equal(client.timers.size, 0)
    assert.equal(client.closes, 1)
  } finally {
    if (client.closes === 0) client.hide()
  }
})

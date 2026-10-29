import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import type { WorkbenchSnapshot } from '../examples/hardware-workbench/contract.ts'

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

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

async function startClient(surface: 'controls' | 'overlay') {
  const elements = new Map<string, Element>()
  const element = (selector: string) => {
    let value = elements.get(selector)
    if (!value) elements.set(selector, (value = new Element()))
    return value
  }
  element('#connection').textContent = 'Connecting to native application…'
  const calls: { method: string; input: unknown }[] = []
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
      querySelectorAll: () => [],
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
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
    get closes() {
      return closes
    },
    async tick() {
      const due = [...timers.values()]
      timers.clear()
      for (const timer of due) {
        assert.equal(timer.delay, 1500)
        timer.callback()
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

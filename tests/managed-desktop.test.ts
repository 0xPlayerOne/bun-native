import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CefBackend, type PolicyScope } from '../packages/runtime/src/cef.ts'
import {
  ManagedGenerationOwner,
  type ManagedGeneration,
} from '../packages/runtime/src/managed-generations.ts'
import {
  ManagedDesktopResources,
  type ManagedDesktopAuthority,
  type ManagedDesktopBinding,
} from '../packages/runtime/src/managed-desktop.ts'
import {
  BunTerminalDriver,
  TerminalService,
  type TerminalDriver,
  type TerminalDriverObserver,
} from '../packages/runtime/src/terminal.ts'
import { ServiceSupervisor } from '../packages/runtime/src/service-supervisor.ts'
import { ServiceReloadHost } from '../packages/runtime/src/service-reload.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'
import { QualificationTerminal } from '../benchmarks/pty/terminal-consumer.ts'

async function fixture(maxEvents = 64) {
  const peer = await nativePeer()
  let next = 0
  const scope = {
    view: 3,
    session: 1,
    generation: 1,
    mainFrame: 'main-frame',
    document: 'native-3-1',
    origin: 'app://ui',
  }
  let intercept: ((command: Command) => boolean) | undefined
  peer.handle((command) => {
    if (intercept?.(command)) return
    peer.reply(
      command,
      command.op.endsWith('.create')
        ? { id: ++next }
        : command.op === 'policy.scope'
          ? scope
          : command.op === 'window.state'
            ? { visible: true, active: true, minimized: false, maximized: false, fullscreen: false }
            : command.op === 'session.cookies'
              ? []
              : null
    )
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'managed' })
  const window = await backend.createWindow({
    title: 'managed',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    session,
    window,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend, { maxEvents })
  const authority = await desktop.captureAuthority(view)
  const policy = (operations: string[]) => ({ authority, permission: 'workspace', operations })
  const cleanup = async () => {
    await desktop.dispose()
    owner.dispose()
    await backend.dispose()
  }
  return {
    ...peer,
    scope,
    backend,
    owner,
    desktop,
    authority,
    policy,
    window,
    view,
    session,
    cleanup,
    intercept(callback?: (command: Command) => boolean) {
      intercept = callback
    },
  }
}
function commit(
  owner: ManagedGenerationOwner,
  resources: Readonly<Record<string, ManagedDesktopBinding>>,
  permissions = ['workspace']
): ManagedGeneration {
  const generation = owner.begin('app:1', permissions)
  for (const binding of Object.values(resources))
    owner.attach(generation, binding.resource, binding.schema)
  owner.commit(generation, '{"revision":1}')
  return generation
}
function output() {
  let resolve!: (outcome: StreamOutcome) => void
  const chunks: Uint8Array[] = []
  const finished = new Promise<StreamOutcome>((yes) => {
    resolve = yes
  })
  const writer: BinaryStreamWriter = {
    finished,
    async write(chunk) {
      chunks.push(chunk.slice())
    },
    async end() {
      resolve({ ok: true })
    },
    cancel() {
      resolve({ ok: false, code: 'CANCELLED' })
    },
  }
  return { writer, chunks }
}
function driver() {
  const observers: TerminalDriverObserver[] = []
  const inputs: Uint8Array[] = []
  const sizes: number[][] = []
  const fake: TerminalDriver = {
    spawn(_options, observer) {
      observers.push(observer)
      return {
        write(bytes) {
          inputs.push(bytes.slice())
          return bytes.length
        },
        resize(cols, rows) {
          sizes.push([cols, rows])
        },
        signal(signalCode) {
          observer.processExited({ exitCode: null, signalCode, waitError: false })
        },
        closeTerminal() {
          observer.terminalClosed(0)
        },
      }
    },
  }
  return { fake, observers, inputs, sizes }
}

test('concrete resource adapters preserve exact native resources over handler generations', async () => {
  const f = await fixture()
  try {
    const session = f.desktop.registerSession('session', f.session, f.policy(['identity', 'flush']))
    const window = f.desktop.registerWindow('window', f.window, f.policy(['state', 'show']))
    const view = f.desktop.registerView('view', f.view, {
      ...f.policy(['state', 'focus']),
      dependsOn: [session, window],
    })
    expect(() => f.desktop.registerView('alias', f.view, f.policy(['state']))).toThrow(
      'INVALID_IDENTITY'
    )
    let generation = commit(f.owner, await f.desktop.prepare())
    const initial = JSON.parse(await f.owner.invoke(generation, view, 'state', 'null'))
    const created = f.commands.filter((c) => c.op.endsWith('.create')).length
    for (let i = 0; i < 20; i++) {
      const previous = generation
      generation = commit(f.owner, await f.desktop.prepare())
      await expect(f.owner.invoke(previous, view, 'state', 'null')).rejects.toThrow('RETIRED')
      expect(JSON.parse(await f.owner.invoke(generation, view, 'state', 'null'))).toEqual(initial)
      expect(JSON.parse(await f.owner.invoke(generation, session, 'identity', 'null'))).toEqual({
        id: f.session.id,
      })
    }
    expect(f.commands.filter((c) => c.op.endsWith('.create')).length).toBe(created)
    expect(f.backend.diagnostics()).toMatchObject({
      windows: 1,
      views: 1,
      sessions: 1,
      listeners: 1,
    })
    expect(f.owner.diagnostics()).toMatchObject({ resources: 3, generations: 1, attachments: 3 })
    await f.owner.invoke(generation, window, 'show', '{"visible":false}')
    expect(f.commands.at(-1)!.op).toBe('window.hide')
  } finally {
    await f.cleanup()
  }
})

test('native scope revalidation rejects forged scopes and native-only document changes', async () => {
  const f = await fixture()
  try {
    const scope = await f.backend.capturePolicyScope(f.view)
    expect(f.backend.isPolicyScopeLocallyCurrent(scope)).toBe(true)
    expect(f.backend.isPolicyScopeLocallyCurrent({ ...scope } as PolicyScope)).toBe(false)
    await expect(f.backend.validatePolicyScope({ ...scope } as PolicyScope)).rejects.toThrow(
      'foreign'
    )
    const view = f.desktop.registerView('view', f.view, f.policy(['state']))
    const generation = commit(f.owner, await f.desktop.prepare())
    f.scope.mainFrame = 'different-native-main-frame'
    await expect(f.owner.invoke(generation, view, 'state', 'null')).rejects.toThrow('DENIED')
    await expect(f.desktop.prepare()).rejects.toThrow('DENIED')
    expect(f.backend.state(f.view).documentId).toBe('native-3-1')
  } finally {
    await f.cleanup()
  }
})

test('copied authorities, changed host policy and reduced generation permissions cannot attach', async () => {
  const f = await fixture()
  try {
    expect(() =>
      f.desktop.registerView('forged', f.view, {
        ...f.policy(['state']),
        authority: { ...f.authority } as ManagedDesktopAuthority,
      })
    ).toThrow('DENIED')
    let permitted = true
    const view = f.desktop.registerView('view', f.view, {
      ...f.policy(['state']),
      authorize: () => permitted,
    })
    const bindings = await f.desktop.prepare()
    const generation = commit(f.owner, bindings)
    const candidate = f.owner.begin('app:1', [])
    expect(() => f.owner.attach(candidate, view, 'bunly.view:1')).toThrow('DENIED')
    f.owner.retire(candidate)
    permitted = false
    expect(bindings['view']!.current()).toBe(false)
    await expect(bindings['view']!.validate()).rejects.toThrow('DENIED')
    await expect(f.desktop.prepare()).rejects.toThrow('DENIED')
    await expect(f.owner.invoke(generation, view, 'state', 'null')).rejects.toThrow('DENIED')
    await expect(
      f.owner.invoke(generation, view, 'navigate', '{"url":"app://ui/next.html"}')
    ).rejects.toThrow('DENIED')
    expect(f.commands.some((c) => c.op === 'policy.native.check')).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('retirement during asynchronous native reauthorization prevents any side effect', async () => {
  const f = await fixture()
  try {
    const window = f.desktop.registerWindow('window', f.window, f.policy(['show']))
    const generation = commit(f.owner, await f.desktop.prepare())
    let pending: Command | undefined
    f.intercept((command) => {
      if (command.op === 'policy.scope') {
        pending = command
        return true
      }
      return false
    })
    const call = f.owner.invoke(generation, window, 'show', '{"visible":false}')
    await turn()
    expect(pending).toBeDefined()
    f.owner.retire(generation)
    f.reply(pending!, f.scope)
    await expect(call).rejects.toThrow('RETIRED')
    await turn()
    expect(f.commands.some((c) => c.op === 'window.hide')).toBe(false)
    expect(f.owner.diagnostics().inFlight).toBe(0)
    f.intercept()
  } finally {
    await f.cleanup()
  }
})

test('reentrant host policy cannot report a just-closed attachment as current', async () => {
  const f = await fixture()
  try {
    let closeOnCheck = false
    let closed: Promise<void> | undefined
    f.desktop.registerWindow('window', f.window, {
      ...f.policy(['state']),
      authorize: () => {
        if (closeOnCheck && !closed) closed = f.desktop.close('window')
        return true
      },
    })
    const bindings = await f.desktop.prepare()
    closeOnCheck = true
    expect(bindings['window']!.current()).toBe(false)
    await closed
    expect(f.owner.diagnostics().resources).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('native navigation racing scope validation rejects the attachment', async () => {
  const f = await fixture()
  try {
    f.desktop.registerView('view', f.view, f.policy(['state']))
    let pending: Command | undefined
    f.intercept((command) => {
      if (command.op === 'policy.scope') {
        pending = command
        return true
      }
      return false
    })
    const preparing = f.desktop.prepare()
    await turn()
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url: 'https://example.invalid/', documentId: 'native-3-2' },
    })
    f.reply(pending!, f.scope)
    await expect(preparing).rejects.toThrow('DENIED')
    f.intercept()
  } finally {
    await f.cleanup()
  }
})

test('a native close during preparation invalidates the candidate without recreating resources', async () => {
  const f = await fixture()
  try {
    const view = f.desktop.registerView('view', f.view, f.policy(['state']))
    const candidate = f.owner.begin('app:1', ['workspace'])
    f.owner.attach(candidate, view, 'bunly.view:1')
    f.send({ v: 1, event: 'window.closed', target: 2, data: null })
    await turn()
    expect(() => f.owner.commit(candidate, 'null')).toThrow('INCOMPATIBLE')
    f.owner.retire(candidate)
    expect(f.backend.diagnostics()).toMatchObject({ windows: 0, views: 0, listeners: 1 })
    expect(f.desktop.diagnostics().resources).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('navigation after native validation cannot publish a Worker with locally revoked authority', async () => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'bunly-managed-scope-'))
  let navigationCommand: Command | undefined
  let navigation: Promise<unknown> | undefined
  let navigateDuringQuiescence = false
  let broker: ServiceReloadHost | undefined
  try {
    f.desktop.registerWindow('window', f.window, f.policy(['state']))
    const bindings = await f.desktop.prepare()
    f.intercept((command) => {
      if (command.op !== 'view.navigate') return false
      navigationCommand = command
      return true
    })
    broker = new ServiceReloadHost({
      owner: f.owner,
      stateSchema: 'app:1',
      permissions: ['workspace'],
      resources: bindings,
      onDiagnostic(event) {
        if (navigateDuringQuiescence && event.event === 'stage' && event.stage === 'quiesce') {
          navigateDuringQuiescence = false
          navigation = f.backend.navigate(f.view, 'app://ui/next.html')
          void navigation.catch(() => {})
        }
      },
    })
    const source = (revision: number) =>
      `export default context => ({schema:'app:1',handlers:{revision:()=>JSON.stringify(${revision}),state:()=>context.invoke('window','state','null')}})`
    const first = join(root, 'first.ts'),
      second = join(root, 'second.ts')
    await writeFile(first, source(1))
    await writeFile(second, source(2))
    await broker.reload({ entry: first })
    expect(JSON.parse(await broker.request('state', 'null'))).toMatchObject({ visible: true })
    navigateDuringQuiescence = true
    await expect(broker.reload({ entry: second })).rejects.toMatchObject({
      code: 'INCOMPATIBLE',
      stage: 'commit',
      candidateRetired: true,
      committed: false,
    })
    expect(navigationCommand).toBeDefined()
    // No native reply or document event has arrived, but navigate already retired the local scope.
    expect(f.backend.state(f.view).documentId).toBe('native-3-1')
    expect(bindings['window']!.current()).toBe(false)
    await expect(bindings['window']!.validate()).rejects.toThrow('DENIED')
    expect(await broker.request('revision', 'null')).toBe('1')
    expect(f.commands.filter((command) => command.op === 'window.state')).toHaveLength(1)
    expect(f.owner.diagnostics()).toMatchObject({
      candidate: 0,
      active: 1,
      resources: 1,
      generations: 1,
    })
  } finally {
    if (navigationCommand) f.reply(navigationCommand)
    await navigation
    f.intercept()
    await broker?.close()
    await f.cleanup()
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

test('one stable listener buffers lifecycle state with bounded explicit acknowledgements', async () => {
  const f = await fixture(2)
  try {
    const preview = await f.backend.createView({
      session: f.session,
      window: f.window,
      url: 'https://example.invalid/',
      trust: { kind: 'remote' },
    })
    const resource = f.desktop.registerView(
      'preview',
      preview,
      f.policy(['events', 'ack-events', 'state'])
    )
    let generation = commit(f.owner, await f.desktop.prepare())
    f.send({
      v: 1,
      event: 'view.loaded',
      target: 4,
      data: { url: 'https://example.invalid/form', documentId: 'native-4-2' },
    })
    await turn()
    const previous = generation
    const events = JSON.parse(await f.owner.invoke(generation, resource, 'events', 'null')) as {
      sequence: number
    }[]
    expect(events).toHaveLength(1)
    generation = commit(f.owner, await f.desktop.prepare())
    await expect(
      f.owner.invoke(
        previous,
        resource,
        'ack-events',
        JSON.stringify({ through: events[0]!.sequence })
      )
    ).rejects.toThrow('RETIRED')
    expect(JSON.parse(await f.owner.invoke(generation, resource, 'events', 'null'))).toEqual(events)
    await f.owner.invoke(
      generation,
      resource,
      'ack-events',
      JSON.stringify({ through: events[0]!.sequence })
    )
    expect(JSON.parse(await f.owner.invoke(generation, resource, 'events', 'null'))).toEqual([])
    for (let n = 3; n <= 5; n++)
      f.send({
        v: 1,
        event: 'view.loaded',
        target: 4,
        data: { url: `https://example.invalid/${n}`, documentId: `native-4-${n}` },
      })
    await turn()
    expect(f.desktop.diagnostics()).toMatchObject({
      listener: 1,
      queuedEvents: 2,
      eventOverflows: 1,
    })
    await expect(f.owner.invoke(generation, resource, 'events', 'null')).rejects.toThrow('CAPACITY')
  } finally {
    await f.cleanup()
  }
})

test('terminal output and the original process remain owned while handlers are replaced', async () => {
  const f = await fixture(),
    d = driver(),
    sink = output()
  const service = new TerminalService({ driver: d.fake })
  try {
    const handle = await service.create(f.view, sink.writer, {
      executable: process.execPath,
      cwd: import.meta.dir,
    })
    const terminal = f.desktop.registerTerminal(
      'terminal',
      service,
      handle,
      f.policy(['identity', 'write', 'resize'])
    )
    let generation = commit(f.owner, await f.desktop.prepare())
    for (let n = 0; n < 12; n++) {
      d.observers[0]!.output(new TextEncoder().encode(`${n}\n`))
      generation = commit(f.owner, await f.desktop.prepare())
      expect(JSON.parse(await f.owner.invoke(generation, terminal, 'identity', 'null'))).toEqual({
        id: handle.id,
      })
      await f.owner.invoke(generation, terminal, 'write', JSON.stringify({ text: `input-${n}\n` }))
    }
    await turn()
    expect(d.observers).toHaveLength(1)
    expect(d.inputs).toHaveLength(12)
    expect(Buffer.concat(sink.chunks).toString()).toBe(
      Array.from({ length: 12 }, (_, n) => `${n}\n`).join('')
    )
    await f.owner.invoke(generation, terminal, 'resize', '{"cols":120,"rows":40}')
    expect(d.sizes).toEqual([[120, 40]])
    await expect(
      f.owner.invoke(generation, terminal, 'write', '{"text":"x","pid":123}')
    ).rejects.toThrow('INVALID_ARGUMENT')
  } finally {
    await f.cleanup()
    await service.dispose()
  }
})

test('real Bun PTY keeps numbered output and the same child through managed reattachment', async () => {
  const f = await fixture()
  const native = new BunTerminalDriver()
  let launches = 0
  const service = new TerminalService({
    driver: {
      spawn(options, observer) {
        launches++
        return native.spawn(options, observer)
      },
    },
  })
  let receive: ((record: Record<string, unknown>) => void) | undefined
  const terminal = new QualificationTerminal((record) => {
    receive?.(record)
    receive = undefined
  })
  const waitRecord = (index: number) => {
    const existing = terminal.records[index]
    return existing
      ? Promise.resolve(existing)
      : new Promise<Record<string, unknown>>((resolve) => {
          receive = resolve
        })
  }
  let finish!: (outcome: StreamOutcome) => void
  const writer: BinaryStreamWriter = {
    finished: new Promise<StreamOutcome>((resolve) => {
      finish = resolve
    }),
    async write(bytes) {
      await terminal.consume(bytes)
    },
    async end() {
      finish({ ok: true })
    },
    cancel() {
      finish({ ok: false, code: 'CANCELLED' })
    },
  }
  try {
    const handle = await service.create(f.view, writer, {
      executable: process.execPath,
      cwd: import.meta.dir,
      argv: [fileURLToPath(new URL('./fixtures/terminal-service-child.ts', import.meta.url))],
      env: { BUNLY_TERMINAL_FIXTURE: 'managed-continuity' },
    })
    const observation = service.observe(handle)
    expect(await waitRecord(0)).toMatchObject({
      type: 'ready',
      tty: true,
      token: 'managed-continuity',
    })
    const resource = f.desktop.registerTerminal('terminal', service, handle, f.policy(['write']))
    let generation = commit(f.owner, await f.desktop.prepare())
    for (let n = 0; n < 10; n++) {
      const value = `managed-${n}-café-🐙`
      await f.owner.invoke(
        generation,
        resource,
        'write',
        JSON.stringify({ text: `input:${Buffer.from(value).toString('base64')}\n` })
      )
      generation = commit(f.owner, await f.desktop.prepare())
      expect(await waitRecord(n + 1)).toEqual({ type: 'input', value })
    }
    expect(launches).toBe(1)
    expect(service.diagnostics().terminals).toBe(1)
    await service.write(handle, new TextEncoder().encode('exit\n'))
    expect(await observation.processExited).toMatchObject({ started: true, exitCode: 7 })
    expect(await observation.outputFinished).toEqual({ ok: true })
    await observation.released
    expect(terminal.records.at(-1)).toEqual({ type: 'final' })
    expect(terminal.records).toHaveLength(12)
    expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
  } finally {
    await f.cleanup()
    await service.dispose()
    terminal.dispose()
  }
}, 20_000)

test('terminal exit invalidates a staged replacement and waits for actual owner release', async () => {
  const f = await fixture(),
    d = driver(),
    sink = output()
  const service = new TerminalService({ driver: d.fake })
  try {
    const handle = await service.create(f.view, sink.writer, {
      executable: process.execPath,
      cwd: import.meta.dir,
    })
    const terminal = f.desktop.registerTerminal('terminal', service, handle, f.policy(['identity']))
    const candidate = f.owner.begin('app:1', ['workspace'])
    f.owner.attach(candidate, terminal, 'bunly.terminal:1')
    d.observers[0]!.processExited({ exitCode: 0, signalCode: null, waitError: false })
    await turn()
    expect(() => f.owner.commit(candidate, 'null')).toThrow('INCOMPATIBLE')
    expect(f.owner.diagnostics().resources).toBe(1)
    d.observers[0]!.terminalClosed(0)
    await service.observe(handle).released
    await turn()
    expect(f.owner.diagnostics().resources).toBe(0)
    f.owner.retire(candidate)
  } finally {
    await f.cleanup()
    await service.dispose()
  }
})

test('managed supervisor reattachment does not spawn a replacement child', async () => {
  const f = await fixture(),
    d = driver()
  const service = new TerminalService({ driver: d.fake })
  const supervisor = new ServiceSupervisor({
    service,
    owner: f.view,
    launch: { executable: process.execPath, cwd: import.meta.dir },
    createOutput: () => ({ writer: output().writer, dispose() {} }),
  })
  try {
    supervisor.start()
    await turn()
    expect(supervisor.snapshot.state).toBe('ready')
    const processResource = f.desktop.registerProcess(
      'process',
      supervisor,
      f.policy(['state', 'write'])
    )
    let generation = commit(f.owner, await f.desktop.prepare())
    const attempt = supervisor.snapshot.generation
    for (let n = 0; n < 5; n++) generation = commit(f.owner, await f.desktop.prepare())
    await f.owner.invoke(generation, processResource, 'write', JSON.stringify({ text: 'ping\n' }))
    expect(supervisor.snapshot.generation).toBe(attempt)
    expect(d.observers).toHaveLength(1)
  } finally {
    await f.cleanup()
    supervisor.dispose()
    await supervisor.settled
    await service.dispose()
  }
})

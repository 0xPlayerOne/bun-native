import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import {
  ServiceReloadError,
  ServiceReloadHost,
  type ServiceReloadDiagnostic,
  type ServiceReloadOptions,
} from '../packages/runtime/src/service-reload.ts'

const workspaces: string[] = []
const hosts: ServiceReloadHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {})
  for (const path of workspaces.splice(0)) await rm(path, { recursive: true, force: true })
})
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bunly-service-reload-'))
  workspaces.push(path)
  return path
}
async function moduleAt(root: string, name: string, source: string): Promise<string> {
  const path = join(root, `${name}.ts`)
  await writeFile(path, source)
  return path
}
function host(options: Partial<ServiceReloadOptions> = {}) {
  const owner = options.owner ?? new ManagedGenerationOwner()
  const instance = new ServiceReloadHost({
    owner,
    stateSchema: 'state:1',
    permissions: ['test'],
    readyTimeoutMs: 1500,
    retireTimeoutMs: 80,
    exitTimeoutMs: 1500,
    quiesceTimeoutMs: 100,
    requestTimeoutMs: 1000,
    ...options,
  })
  hosts.push(instance)
  return { host: instance, owner }
}
const simple = (revision: number, extra = '') =>
  `export default (context) => ({schema:'state:1',handlers:{read:()=>JSON.stringify({revision:${revision},state:context.state}),${extra}}})`
async function eventually(check: () => boolean, maximum = 1000): Promise<void> {
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start >= maximum) throw new Error('Condition did not settle')
    await Bun.sleep(2)
  }
}
async function failure(
  work: Promise<unknown>,
  code: ServiceReloadError['code']
): Promise<ServiceReloadError> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceReloadError)
    expect((error as ServiceReloadError).code).toBe(code)
    return error as ServiceReloadError
  }
  throw new Error(`Expected ${code}`)
}

describe('actual isolated service generation reload', () => {
  test.each(['worker', 'process'] as const)(
    '%s reloads fresh dependencies while retaining owner resources',
    async (mechanism) => {
      const root = await workspace()
      const entry = await moduleAt(
        root,
        'app',
        `import {revision} from './dependency.ts'; export default context=>({schema:'state:1',handlers:{read:()=>JSON.stringify(revision),invoke:input=>context.invoke('counter','add',input)}})`
      )
      await moduleAt(root, 'dependency', 'export const revision=1')
      const owner = new ManagedGenerationOwner()
      let count = 0,
        disposed = 0
      const resource = owner.register({
        kind: 'window',
        schema: 'counter:1',
        permission: 'test',
        authorize: () => true,
        invoke: (_operation, input) => JSON.stringify((count += JSON.parse(input) as number)),
        dispose: () => {
          disposed++
        },
      })
      const { host: service } = host({
        owner,
        mechanism,
        resources: { counter: { resource, schema: 'counter:1' } },
      })
      const first = await service.reload({ entry })
      expect(first.replaced).toBe(false)
      expect(await service.request('read', 'null')).toBe('1')
      expect(await service.request('invoke', '2')).toBe('2')
      await moduleAt(root, 'dependency', 'export const revision=2')
      const second = await service.reload({ entry })
      expect(second.replaced).toBe(true)
      expect(await service.request('read', 'null')).toBe('2')
      expect(await service.request('invoke', '3')).toBe('5')
      expect(disposed).toBe(0)
      expect(service.diagnostics().generations).toBe(1)
      await service.close()
      expect(service.diagnostics().generations).toBe(0)
      expect(owner.diagnostics().resources).toBe(1)
      await owner.disposeResource(resource)
      expect(disposed).toBe(1)
    }
  )

  test('preparation failures preserve the previous handler and snapshot', async () => {
    const root = await workspace()
    const { host: service } = host({ initialState: '{"kept":true}' })
    await service.reload({ entry: await moduleAt(root, 'good', simple(1)) })
    for (const [name, source] of [
      ['syntax', 'export default ('],
      ['import', "import './missing.ts'; export default ()=>({})"],
      ['initialize', 'export default ()=>{throw new Error("initialization-failed")}'],
      [
        'duplicate',
        "export default ctx=>{ctx.handle('same',()=> 'null');return {schema:'state:1',handlers:{same:()=> 'null'}}}",
      ],
    ]) {
      const problem = await failure(
        service.reload({ entry: await moduleAt(root, name!, source!) }),
        'PREPARE_FAILED'
      )
      expect(problem.candidateRetired).toBe(true)
      expect(problem.committed).toBe(false)
      expect(problem.detail).toBeTruthy()
      expect(JSON.parse(await service.request('read', 'null'))).toEqual({
        revision: 1,
        state: '{"kept":true}',
      })
    }
    await failure(
      service.reload({
        entry: await moduleAt(
          root,
          'schema',
          "export default ()=>({schema:'state:2',handlers:{read:()=> 'null'}})"
        ),
      }),
      'INCOMPATIBLE'
    )
    expect(service.diagnostics().owner.active).toBe(1)
    expect(service.diagnostics().owner.candidate).toBe(0)
  })

  test('old generation serves during preparation, rapid edits are bounded, and cutover replaces all handlers', async () => {
    const root = await workspace(),
      { host: service } = host()
    await service.reload({ entry: await moduleAt(root, 'initial', simple(1)) })
    const replacement = await moduleAt(
      root,
      'next',
      "export default async()=>{await Bun.sleep(100);return {schema:'state:1',handlers:{read:()=> '2',next:()=> '3'}}}"
    )
    const reload = service.reload({ entry: replacement })
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(1)
    await failure(service.reload({ entry: replacement }), 'BUSY')
    expect(service.diagnostics().generations).toBe(2)
    await reload
    expect(await service.request('read', 'null')).toBe('2')
    expect(await service.request('next', 'null')).toBe('3')
    expect(service.diagnostics().generations).toBe(1)
  })

  test.each(['worker', 'process'] as const)(
    '%s terminates a synchronous-loop candidate without killing the stable owner',
    async (mechanism) => {
      const root = await workspace(),
        // A process candidate must start a fresh Bun runtime before it can reach
        // the loop. Keep the deadline bounded, but leave room for cold startup.
        { host: service } = host({ mechanism, readyTimeoutMs: 1500 })
      await service.reload({ entry: await moduleAt(root, 'good', simple(1)) })
      const loop = await moduleAt(root, 'loop', 'export default ()=>{for(;;){}}')
      const problem = await failure(service.reload({ entry: loop }), 'TIMEOUT')
      expect(problem.candidateRetired).toBe(true)
      expect(service.diagnostics().forcedTerminations).toBeGreaterThanOrEqual(1)
      expect(JSON.parse(await service.request('read', 'null')).revision).toBe(1)
      expect(service.diagnostics().generations).toBe(1)
    }
  )

  test('pending callers settle on cutover, and late old replies cannot satisfy a new call', async () => {
    const root = await workspace(),
      { host: service } = host()
    await service.reload({
      entry: await moduleAt(
        root,
        'slow',
        simple(1, "slow:async()=>{await Bun.sleep(300);return '999'},")
      ),
    })
    const pending = service.request('slow', 'null')
    const observed = failure(pending, 'RETIRED')
    await service.reload({ entry: await moduleAt(root, 'next', simple(2)) })
    await observed
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(2)
    expect(service.diagnostics().requests).toBe(0)
  })

  test('request timeout retains admission until actual handler completion or exit', async () => {
    const root = await workspace(),
      { host: service } = host({ limits: { requests: 1 } })
    await service.reload({
      entry: await moduleAt(root, 'pending', simple(1, 'pending:()=>new Promise(()=>{}),')),
    })
    await failure(service.request('pending', 'null', { timeoutMs: 20 }), 'TIMEOUT')
    expect(service.diagnostics().requests).toBe(1)
    expect(service.diagnostics().unsettledCallers).toBe(0)
    await failure(service.request('read', 'null'), 'CAPACITY')
    await service.reload({ entry: await moduleAt(root, 'recovered', simple(2)) })
    expect(service.diagnostics().requests).toBe(0)
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(2)
  })

  test('unsettled native operation refuses cutover and remains charged after caller cancellation', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    let settle!: (value: string) => void
    const resource = owner.register({
      kind: 'process',
      schema: 'operation:1',
      permission: 'test',
      authorize: () => true,
      invoke: () =>
        new Promise<string>((resolve) => {
          settle = resolve
        }),
      dispose: () => {},
    })
    const { host: service } = host({
      owner,
      resources: { task: { resource, schema: 'operation:1' } },
      quiesceTimeoutMs: 40,
    })
    await service.reload({
      entry: await moduleAt(
        root,
        'active',
        "export default ctx=>({schema:'state:1',handlers:{work:()=>ctx.invoke('task','run','null'),read:()=> '1'}})"
      ),
    })
    const result = failure(service.request('work', 'null'), 'RETIRED')
    await eventually(() => owner.diagnostics().inFlight === 1)
    const next = await moduleAt(root, 'next', simple(2))
    const problem = await failure(service.reload({ entry: next }), 'RESTART_REQUIRED')
    expect(problem.restartRequired).toBe(true)
    await result
    expect(owner.diagnostics().inFlight).toBe(1)
    expect(await service.request('read', 'null')).toBe('1')
    settle('null')
    await eventually(() => owner.diagnostics().inFlight === 0)
    await service.reload({ entry: next })
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(2)
  })

  test('resource closure during readiness invalidates candidate; fresh host mapping can omit it', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    const resource = owner.register({
      kind: 'view',
      schema: 'view:1',
      permission: 'test',
      authorize: () => true,
      invoke: () => 'null',
      dispose: () => {},
    })
    const { host: service } = host({ owner, resources: { view: { resource, schema: 'view:1' } } })
    await service.reload({ entry: await moduleAt(root, 'first', simple(1)) })
    const entry = await moduleAt(
      root,
      'next',
      "export default async()=>{await Bun.sleep(80);return {schema:'state:1',handlers:{read:()=> '2'}}}"
    )
    const change = service.reload({ entry })
    await owner.disposeResource(resource)
    await failure(change, 'INCOMPATIBLE')
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(1)
    await service.reload({ entry, resources: {} })
    expect(await service.request('read', 'null')).toBe('2')
  })

  test('shutdown during preparation settles reload and callers, with no active generation', async () => {
    const root = await workspace(),
      { host: service } = host()
    await service.reload({
      entry: await moduleAt(root, 'good', simple(1, 'pending:()=>new Promise(()=>{}),')),
    })
    const result = failure(service.request('pending', 'null'), 'CLOSED')
    const loading = failure(
      service.reload({
        entry: await moduleAt(root, 'wait', 'export default ()=>new Promise(()=>{})'),
      }),
      'CLOSED'
    )
    await service.close()
    await Promise.all([result, loading])
    expect(service.diagnostics().generations).toBe(0)
    expect(service.diagnostics().requests).toBe(0)
    expect(service.diagnostics().owner.active).toBe(0)
    await failure(service.reload({ entry: join(root, 'good.ts') }), 'CLOSED')
  })

  test('cleanup failure is not silently reported as rollback or resource release', async () => {
    const root = await workspace(),
      { host: service, owner } = host()
    await service.reload({
      entry: await moduleAt(
        root,
        'cleanup',
        "export default()=>({schema:'state:1',handlers:{read:()=> '1'},dispose:()=>{throw new Error('cleanup-failed')}})"
      ),
    })
    const problem = await failure(
      service.reload({ entry: await moduleAt(root, 'next', simple(2)) }),
      'CLEANUP_FAILED'
    )
    expect(problem.committed).toBe(true)
    expect(problem.restartRequired).toBe(true)
    expect(problem.candidateRetired).toBe(false)
    await eventually(() => owner.diagnostics().failedCleanup === 1)
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(2)
    await failure(service.close(), 'RESTART_REQUIRED')
  })

  test('source-mapped failure details and structured stages accompany diagnostics', async () => {
    const root = await workspace(),
      diagnostics: ServiceReloadDiagnostic[] = []
    const { host: service } = host({ onDiagnostic: (event) => diagnostics.push(event) })
    const source = await moduleAt(
      root,
      'source',
      "export default()=>{\nthrow new Error('mapped-initialization-failure')\n}"
    )
    const built = await Bun.build({
      entrypoints: [source],
      outdir: root,
      naming: 'mapped.js',
      target: 'bun',
      sourcemap: 'linked',
    })
    expect(built.success).toBe(true)
    const problem = await failure(
      service.reload({ entry: join(root, 'mapped.js') }),
      'PREPARE_FAILED'
    )
    expect(problem.detail).toContain('mapped-initialization-failure')
    expect(problem.detail).toContain('source.ts:')
    expect(diagnostics.some((item) => item.event === 'failure' && item.stage === 'prepare')).toBe(
      true
    )
    expect(diagnostics.every((item) => item.elapsedMs >= 0)).toBe(true)
  })

  test('cancelled handler continuations cannot start another managed mutation', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    let mutations = 0
    const resource = owner.register({
      kind: 'process',
      schema: 'process:1',
      permission: 'test',
      authorize: () => true,
      invoke: () => {
        mutations++
        return 'null'
      },
      dispose: () => {},
    })
    const { host: service } = host({
      owner,
      resources: { task: { resource, schema: 'process:1' } },
    })
    await service.reload({
      entry: await moduleAt(
        root,
        'cancel',
        "export default ctx=>({schema:'state:1',handlers:{late:async()=>{await Bun.sleep(60);return await ctx.invoke('task','write','null')},read:()=> '1'}})"
      ),
    })
    const controller = new AbortController()
    const cancelled = failure(
      service.request('late', 'null', { signal: controller.signal }),
      'CANCELLED'
    )
    controller.abort()
    await cancelled
    await eventually(() => service.diagnostics().requests === 0)
    expect(mutations).toBe(0)
    expect(await service.request('read', 'null')).toBe('1')
  })

  test('candidate cannot invoke resources, and current authorization is checked for each active call', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    let allowed = true,
      mutations = 0
    const resource = owner.register({
      kind: 'window',
      schema: 'window:1',
      permission: 'test',
      authorize: () => allowed,
      invoke: () => {
        mutations++
        return '1'
      },
      dispose: () => {},
    })
    const { host: service } = host({
      owner,
      resources: { window: { resource, schema: 'window:1' } },
    })
    await failure(
      service.reload({
        entry: await moduleAt(
          root,
          'eager',
          "export default async ctx=>{await ctx.invoke('window','write','null');return {schema:'state:1',handlers:{read:()=> '1'}}}"
        ),
      }),
      'PREPARE_FAILED'
    )
    expect(mutations).toBe(0)
    await service.reload({
      entry: await moduleAt(
        root,
        'safe',
        "export default ctx=>({schema:'state:1',handlers:{write:()=>ctx.invoke('window','write','null')}})"
      ),
    })
    expect(await service.request('write', 'null')).toBe('1')
    allowed = false
    await failure(service.request('write', 'null'), 'APPLICATION_FAILED')
    expect(mutations).toBe(1)
  })

  test.each(['worker', 'process'] as const)(
    '%s releases an owned listener before successful reload returns',
    async (mechanism) => {
      const root = await workspace(),
        { host: service } = host({ mechanism })
      const entry = await moduleAt(
        root,
        'listener',
        "export default ctx=>{const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('alive')});ctx.own(()=>server.stop(true));return {schema:'state:1',handlers:{port:()=>String(server.port)}}}"
      )
      await service.reload({ entry })
      const port = Number(await service.request('port', 'null'))
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('alive')
      await service.reload({ entry: await moduleAt(root, 'replacement', simple(2)) })
      const rebound = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: () => new Response('replacement'),
      })
      try {
        expect(await (await fetch(rebound.url)).text()).toBe('replacement')
      } finally {
        rebound.stop(true)
      }
    }
  )

  test('asynchronous active-generation crash settles callers and permits explicit fresh recovery', async () => {
    const root = await workspace(),
      { host: service } = host()
    await service.reload({
      entry: await moduleAt(
        root,
        'crash',
        "export default()=>({schema:'state:1',handlers:{crash:()=>{setTimeout(()=>{throw new Error('async-crash')},0);return new Promise(()=>{})}}})"
      ),
    })
    await failure(service.request('crash', 'null'), 'APPLICATION_FAILED')
    await eventually(
      () => service.diagnostics().active === null && service.diagnostics().requests === 0
    )
    await failure(service.request('crash', 'null'), 'NOT_ACTIVE')
    await service.reload({ entry: await moduleAt(root, 'recovered', simple(2)) })
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(2)
  })

  test('owner disposal reentered from generation retirement never resurrects active routing', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    const { host: service } = host({ owner })
    await service.reload({ entry: await moduleAt(root, 'first', simple(1)) })
    // Stable-host callbacks are allowed to reenter owner lifecycle during commit.
    const originalCommit = owner.commit.bind(owner)
    owner.commit = (generation, state) => {
      originalCommit(generation, state)
      owner.dispose()
    }
    const problem = await failure(
      service.reload({ entry: await moduleAt(root, 'next', simple(2)) }),
      'RESTART_REQUIRED'
    )
    expect(problem.committed).toBe(true)
    expect(owner.diagnostics().active).toBe(0)
    expect(service.diagnostics().active).not.toBe(2)
    await failure(service.request('read', 'null'), 'NOT_ACTIVE')
  })

  test('attachment authority is revalidated after readiness and immediately before commit', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    let allowed = true,
      validations = 0
    const resource = owner.register({
      kind: 'view',
      schema: 'view:1',
      permission: 'test',
      authorize: () => allowed,
      invoke: () => 'null',
      dispose: () => {},
    })
    const resources = {
      view: {
        resource,
        schema: 'view:1',
        validate: async () => {
          validations++
        },
        current: () => allowed,
      },
    }
    const { host: service } = host({ owner, resources })
    await service.reload({ entry: await moduleAt(root, 'initial', simple(1)) })
    expect(validations).toBe(1)
    const next = await moduleAt(
      root,
      'next',
      "export default async()=>{await Bun.sleep(50);return {schema:'state:1',handlers:{read:()=> '2'}}}"
    )
    const pending = service.reload({ entry: next })
    allowed = false
    const problem = await failure(pending, 'INCOMPATIBLE')
    expect(problem.stage).toBe('commit')
    expect(problem.committed).toBe(false)
    expect(validations).toBe(2)
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(1)
    allowed = true
    await service.reload({ entry: next })
    expect(await service.request('read', 'null')).toBe('2')
  })

  test('host validation never starts when its work reservation is rejected', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner({ work: 2 })
    let validations = 0
    const resource = owner.register({
      kind: 'view',
      schema: 'view:1',
      permission: 'test',
      authorize: () => true,
      invoke: () => 'null',
      dispose: () => {},
    })
    const { host: service } = host({ owner })
    const entry = await moduleAt(root, 'good', simple(1))
    await service.reload({ entry })
    // The active and candidate isolate lifetimes consume both available work slots.
    const problem = await failure(
      service.reload({
        entry,
        resources: {
          view: {
            resource,
            schema: 'view:1',
            validate: () => {
              validations++
              return new Promise<void>(() => {})
            },
          },
        },
      }),
      'INCOMPATIBLE'
    )
    expect(problem.stage).toBe('validate')
    expect(problem.committed).toBe(false)
    expect(validations).toBe(0)
    expect(owner.diagnostics().work).toBe(1)
    expect(owner.diagnostics().generations).toBe(1)
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(1)
    await service.close()
    expect(owner.diagnostics().work).toBe(0)
    expect(owner.diagnostics().generations).toBe(0)
    await owner.disposeResource(resource)
  })

  test('timed-out host validation retains its work until actual settlement', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    let complete!: () => void
    const resource = owner.register({
      kind: 'view',
      schema: 'view:1',
      permission: 'test',
      authorize: () => true,
      invoke: () => 'null',
      dispose: () => {},
    })
    const { host: service } = host({ owner, readyTimeoutMs: 100 })
    const entry = await moduleAt(root, 'good', simple(1))
    await service.reload({ entry })
    const problem = await failure(
      service.reload({
        entry,
        resources: {
          view: {
            resource,
            schema: 'view:1',
            validate: () =>
              new Promise<void>((resolve) => {
                complete = resolve
              }),
          },
        },
      }),
      'RESTART_REQUIRED'
    )
    expect(problem.stage).toBe('validate')
    expect(owner.diagnostics().generations).toBe(2)
    expect(owner.diagnostics().work).toBeGreaterThanOrEqual(2)
    complete()
    await eventually(() => owner.diagnostics().generations === 1)
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(1)
  })

  test('shutdown cannot report completion while an earlier retired validator is unresolved', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    let complete!: () => void
    const resource = owner.register({
      kind: 'view',
      schema: 'view:1',
      permission: 'test',
      authorize: () => true,
      invoke: () => 'null',
      dispose: () => {},
    })
    const { host: service } = host({ owner, readyTimeoutMs: 100 })
    const entry = await moduleAt(root, 'good', simple(1))
    await service.reload({ entry })
    await failure(
      service.reload({
        entry,
        resources: {
          view: {
            resource,
            schema: 'view:1',
            validate: () =>
              new Promise<void>((resolve) => {
                complete = resolve
              }),
          },
        },
      }),
      'RESTART_REQUIRED'
    )
    await failure(service.close(), 'RESTART_REQUIRED')
    expect(owner.diagnostics().generations).toBe(1)
    complete()
    await eventually(() => owner.diagnostics().generations === 0)
  })

  test('quiescence wakes on real adapter completion after resource-close caller cancellation', async () => {
    const root = await workspace(),
      owner = new ManagedGenerationOwner()
    let complete!: (value: string) => void
    const resource = owner.register({
      kind: 'view',
      schema: 'view:1',
      permission: 'test',
      authorize: () => true,
      invoke: () =>
        new Promise<string>((resolve) => {
          complete = resolve
        }),
      dispose: () => {},
    })
    const { host: service } = host({
      owner,
      resources: { view: { resource, schema: 'view:1' } },
      onDiagnostic: (event) => {
        if (event.generation === 2 && event.stage === 'quiesce' && event.event === 'stage')
          setImmediate(() => complete('null'))
      },
    })
    await service.reload({
      entry: await moduleAt(
        root,
        'first',
        "export default ctx=>({schema:'state:1',handlers:{work:()=>ctx.invoke('view','wait','null')}})"
      ),
    })
    const call = failure(service.request('work', 'null'), 'APPLICATION_FAILED')
    await eventually(() => owner.diagnostics().inFlight === 1)
    const closing = owner.disposeResource(resource)
    await call
    expect(owner.diagnostics().inFlight).toBe(1)
    await service.reload({ entry: await moduleAt(root, 'next', simple(2)), resources: {} })
    await closing
    expect(owner.diagnostics().inFlight).toBe(0)
    expect(JSON.parse(await service.request('read', 'null')).revision).toBe(2)
  })
})

import { test, expect } from 'bun:test'
import {
  ManagedGenerationOwner,
  ManagedError,
  type ManagedResourceDefinition,
  type ManagedGeneration,
  type ManagedResource,
  type ManagedCallContext,
} from '../packages/runtime/src/index.ts'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function definition(extra: Partial<ManagedResourceDefinition> = {}): ManagedResourceDefinition {
  return {
    kind: 'window',
    schema: 'window:1',
    permission: 'window:use',
    authorize: () => true,
    invoke: (_operation, input) => input,
    dispose: () => {},
    ...extra,
  }
}
function active(owner: ManagedGenerationOwner, resource: ManagedResource, schema = 'app:1') {
  const generation = owner.begin(schema, ['window:use'])
  owner.attach(generation, resource, 'window:1')
  owner.commit(generation, '{"revision":1}')
  return generation
}
const code = (name: string) => (error: unknown) =>
  error instanceof ManagedError && error.code === name

test('stable resources survive generation replacement and old scopes lose authority', async () => {
  const owner = new ManagedGenerationOwner()
  let disposed = 0
  const resource = owner.register(
    definition({
      dispose: () => {
        disposed++
      },
    })
  )
  const old = active(owner, resource)
  const scope = owner.scope(old)
  const next = owner.begin('app:1', ['window:use'])
  owner.attach(next, resource, 'window:1')
  expect(owner.state(next)).toBe('{"revision":1}')
  owner.commit(next, '{"revision":2}')
  expect(scope.signal.aborted).toBe(true)
  expect(() => scope.state()).toThrow('RETIRED')
  await expect(scope.invoke(resource, 'read', 'null')).rejects.toThrow('RETIRED')
  expect(await owner.invoke(next, resource, 'read', '{"ok":true}')).toBe('{"ok":true}')
  expect(owner.diagnostics().inFlight).toBe(0)
  expect(disposed).toBe(0)
  owner.dispose()
  await flush()
  expect(disposed).toBe(1)
  expect(owner.diagnostics()).toEqual({
    closed: true,
    resources: 0,
    attachments: 0,
    generations: 0,
    work: 0,
    active: 0,
    candidate: 0,
    inFlight: 0,
    failedCleanup: 0,
  })
})

test('preparing generations cannot invoke or run bound active callbacks', async () => {
  const owner = new ManagedGenerationOwner()
  let calls = 0
  const resource = owner.register(
    definition({
      invoke: () => {
        calls++
        return 'null'
      },
    })
  )
  const gen = owner.begin('app:1', ['window:use'])
  owner.attach(gen, resource, 'window:1')
  const work = owner.own(gen, 'handler', () => {})
  const callback = owner.callback(gen, work, () => {
    calls++
  })
  await expect(owner.invoke(gen, resource, 'read', 'null')).rejects.toThrow('NOT_ACTIVE')
  expect(callback()).toBe(false)
  expect(calls).toBe(0)
  owner.dispose()
  await flush()
})

test('forged, foreign and wrong-kind tokens cannot address live owners', async () => {
  const owner = new ManagedGenerationOwner(),
    other = new ManagedGenerationOwner()
  const resource = owner.register(definition()),
    gen = active(owner, resource)
  const forged = Object.freeze({}) as ManagedGeneration
  expect(() => owner.state(forged)).toThrow('INVALID_IDENTITY')
  expect(() => other.state(gen)).toThrow('INVALID_IDENTITY')
  expect(() => owner.state(resource as unknown as ManagedGeneration)).toThrow('INVALID_IDENTITY')
  await expect(owner.invoke(gen, {} as ManagedResource, 'read', 'null')).rejects.toThrow('DENIED')
  owner.dispose()
  other.dispose()
  await flush()
})

test('incompatible state, resource schemas and reduced permissions preserve the active generation', async () => {
  const owner = new ManagedGenerationOwner(),
    resource = owner.register(definition())
  const old = active(owner, resource)
  let candidate = owner.begin('app:2', ['window:use'])
  expect(() => owner.state(candidate)).toThrow('INCOMPATIBLE')
  expect(() => owner.commit(candidate, 'null')).toThrow('INCOMPATIBLE')
  owner.retire(candidate)
  candidate = owner.begin('app:1', [])
  expect(() => owner.attach(candidate, resource, 'window:1')).toThrow('DENIED')
  owner.retire(candidate)
  candidate = owner.begin('app:1', ['window:use'])
  expect(() => owner.attach(candidate, resource, 'window:2')).toThrow('INCOMPATIBLE')
  expect(owner.state(old)).toBe('{"revision":1}')
  expect(await owner.invoke(old, resource, 'read', 'null')).toBe('null')
  owner.dispose()
  await flush()
})

test('candidate rejection disposes its work, not the active resources or state', async () => {
  const owner = new ManagedGenerationOwner(),
    resource = owner.register(definition())
  const old = active(owner, resource)
  const candidate = owner.begin('app:1', ['window:use'])
  let removed = 0
  owner.own(candidate, 'listener', () => {
    removed++
  })
  owner.retire(candidate)
  owner.retire(candidate)
  await flush()
  expect(removed).toBe(1)
  expect(owner.diagnostics().generations).toBe(1)
  expect(owner.state(old)).toBe('{"revision":1}')
  owner.dispose()
  await flush()
})

test('closing a staged resource rejects commit rather than silently dropping an attachment', async () => {
  const owner = new ManagedGenerationOwner(),
    resource = owner.register(definition())
  const gen = owner.begin('app:1', ['window:use'])
  owner.attach(gen, resource, 'window:1')
  await owner.disposeResource(resource)
  expect(() => owner.commit(gen, 'null')).toThrow('INCOMPATIBLE')
  owner.detach(gen, resource)
  expect(() => owner.commit(gen, 'null')).toThrow('INCOMPATIBLE')
  owner.retire(gen)
  owner.commit(owner.begin('app:1', []), 'null')
  owner.dispose()
  await flush()
})

test('retirement settles the caller immediately but retains an uncooperative operation and blocks cutover', async () => {
  const owner = new ManagedGenerationOwner(),
    pending = gate<string>()
  let context: ManagedCallContext | undefined
  const resource = owner.register(
    definition({
      invoke: (_op, _input, c) => {
        context = c
        return pending.promise
      },
    })
  )
  const gen = active(owner, resource)
  const call = owner.invoke(gen, resource, 'wait', 'null')
  await flush()
  owner.retire(gen)
  await expect(call).rejects.toThrow('RETIRED')
  expect(context!.signal.aborted).toBe(true)
  expect(context!.isCurrent()).toBe(false)
  expect(owner.diagnostics().inFlight).toBe(1)
  const next = owner.begin('app:1', ['window:use'])
  owner.attach(next, resource, 'window:1')
  expect(() => owner.commit(next, 'null')).toThrow('BUSY')
  pending.resolve('"late"')
  await flush()
  expect(owner.diagnostics().inFlight).toBe(0)
  owner.commit(next, 'null')
  owner.dispose()
  await flush()
})

test('detaching and reattaching cannot revive a pending result from the old attachment', async () => {
  const owner = new ManagedGenerationOwner(),
    pending = gate<string>()
  const resource = owner.register(definition({ invoke: () => pending.promise })),
    gen = active(owner, resource)
  const call = owner.invoke(gen, resource, 'wait', 'null')
  await flush()
  owner.detach(gen, resource)
  owner.attach(gen, resource, 'window:1')
  pending.resolve('"old"')
  await expect(call).rejects.toThrow('RETIRED')
  await flush()
  expect(owner.diagnostics().work).toBe(0)
  owner.dispose()
  await flush()
})

test('resource release waits for actual adapter settlement even after caller cancellation', async () => {
  const owner = new ManagedGenerationOwner(),
    pending = gate<string>()
  let disposals = 0
  const resource = owner.register(
      definition({
        invoke: () => pending.promise,
        dispose: () => {
          disposals++
        },
      })
    ),
    gen = active(owner, resource)
  const call = owner.invoke(gen, resource, 'wait', 'null')
  await flush()
  const disposed = owner.disposeResource(resource)
  await expect(call).rejects.toThrow('RETIRED')
  await flush()
  expect(disposals).toBe(0)
  expect(owner.diagnostics().resources).toBe(1)
  pending.reject(new Error('private adapter detail'))
  await disposed
  expect(disposals).toBe(1)
  expect(owner.diagnostics().resources).toBe(0)
  owner.dispose()
  await flush()
})

test('permission is revalidated on every call and reentrancy cannot bypass retirement', async () => {
  const owner = new ManagedGenerationOwner()
  let allowed = true,
    calls = 0
  const resource = owner.register(
    definition({
      authorize: () => allowed,
      invoke: () => {
        calls++
        return 'null'
      },
    })
  )
  const gen = active(owner, resource)
  expect(await owner.invoke(gen, resource, 'read', 'null')).toBe('null')
  allowed = false
  await expect(owner.invoke(gen, resource, 'read', 'null')).rejects.toThrow('DENIED')
  expect(calls).toBe(1)
  const reentrant = owner.register(
    definition({
      authorize: () => {
        owner.retire(gen)
        return true
      },
      invoke: () => {
        calls++
        return 'null'
      },
    })
  )
  owner.attach(gen, reentrant, 'window:1')
  await expect(owner.invoke(gen, reentrant, 'read', 'null')).rejects.toThrow('RETIRED')
  expect(calls).toBe(1)
  owner.dispose()
  await flush()
})

test('retirement before scheduled dispatch never enters the adapter', async () => {
  const owner = new ManagedGenerationOwner()
  let calls = 0
  const resource = owner.register(
      definition({
        invoke: () => {
          calls++
          return 'null'
        },
      })
    ),
    gen = active(owner, resource)
  const call = owner.invoke(gen, resource, 'read', 'null')
  owner.retire(gen)
  await expect(call).rejects.toThrow('RETIRED')
  await flush()
  expect(calls).toBe(0)
  expect(owner.diagnostics().work).toBe(0)
  owner.dispose()
  await flush()
})

test('unsettled cleanup and failed cleanup keep generation and work reservations charged', async () => {
  const owner = new ManagedGenerationOwner({ generations: 2, work: 2 }),
    pending = gate<void>()
  const gen = owner.begin('app:1', [])
  owner.commit(gen, 'null')
  let fails = true,
    attempts = 0
  owner.own(gen, 'timer', () => pending.promise)
  owner.own(gen, 'listener', () => {
    attempts++
    if (fails) throw Error('private cleanup')
  })
  owner.retire(gen)
  await flush()
  expect(owner.diagnostics().work).toBe(2)
  expect(owner.diagnostics().failedCleanup).toBe(1)
  const next = owner.begin('app:1', [])
  owner.commit(next, 'null')
  expect(() => owner.begin('app:1', [])).toThrow('CAPACITY')
  expect(() => owner.own(next, 'handler', () => {})).toThrow('CAPACITY')
  pending.resolve()
  await flush()
  expect(owner.diagnostics().work).toBe(1)
  expect(attempts).toBe(1)
  fails = false
  owner.retryFailed()
  await flush()
  expect(attempts).toBe(2)
  expect(owner.diagnostics().generations).toBe(1)
  owner.dispose()
  await flush()
})

test('failed resource disposal requires explicit retry and cannot free capacity', async () => {
  const owner = new ManagedGenerationOwner({ resources: 1 })
  let fails = true,
    attempts = 0
  const resource = owner.register(
    definition({
      dispose: () => {
        attempts++
        if (fails) throw Error('private')
      },
    })
  )
  await expect(owner.disposeResource(resource)).rejects.toThrow('CLEANUP_FAILED')
  await expect(owner.disposeResource(resource)).rejects.toThrow('CLEANUP_FAILED')
  expect(attempts).toBe(1)
  expect(() => owner.register(definition())).toThrow('CAPACITY')
  fails = false
  owner.retryFailed()
  await owner.disposeResource(resource)
  expect(attempts).toBe(2)
  expect(owner.diagnostics().resources).toBe(0)
  await owner.disposeResource(resource)
  owner.dispose()
})

test('reentrant disposal during replacement abort cannot resurrect the candidate', async () => {
  const owner = new ManagedGenerationOwner(),
    resource = owner.register(definition()),
    old = active(owner, resource)
  owner.scope(old).signal.addEventListener('abort', () => owner.dispose(), { once: true })
  const next = owner.begin('app:1', ['window:use'])
  owner.attach(next, resource, 'window:1')
  owner.commit(next, 'null')
  await flush()
  expect(owner.diagnostics().closed).toBe(true)
  expect(owner.diagnostics().active).toBe(0)
  expect(() => owner.begin('app:1', [])).toThrow('DISPOSED')
  expect(() => owner.scope(next)).toThrow('RETIRED')
})

test('cleanup reentrancy cannot install replacement work in a retired generation', async () => {
  const owner = new ManagedGenerationOwner(),
    gen = owner.begin('app:1', [])
  let attempted = false
  owner.own(gen, 'listener', () => {
    attempted = true
    expect(() => owner.own(gen, 'handler', () => {})).toThrow('RETIRED')
    owner.dispose()
  })
  owner.retire(gen)
  await flush()
  expect(attempted).toBe(true)
  expect(owner.diagnostics().work).toBe(0)
})

test('work-bound callbacks are revoked by release, replacement and owner disposal', async () => {
  const owner = new ManagedGenerationOwner(),
    resource = owner.register(definition()),
    gen = active(owner, resource)
  let calls = 0
  const work = owner.own(gen, 'handler', () => {})
  const callback = owner.callback(gen, work, () => {
    calls++
  })
  callback()
  expect(calls).toBe(1)
  const releasing = owner.release(gen, work)
  expect(callback()).toBe(false)
  await releasing
  const next = owner.begin('app:1', [])
  expect(() => owner.release(next, work)).toThrow('INVALID_IDENTITY')
  owner.dispose()
  await flush()
})

test('JSON snapshot bounds apply to state, inputs, outputs and malformed values', async () => {
  const owner = new ManagedGenerationOwner({ stateBytes: 32 })
  const resource = owner.register(definition({ invoke: () => '"' + 'x'.repeat(40) + '"' }))
  const gen = active(owner, resource)
  for (const value of ['{', '"' + 'x'.repeat(33) + '"', '"' + 'é'.repeat(20) + '"']) {
    await expect(owner.invoke(gen, resource, 'read', value)).rejects.toThrow('INVALID_ARGUMENT')
  }
  await expect(owner.invoke(gen, resource, 'read', 'null')).rejects.toThrow('INVALID_ARGUMENT')
  const next = owner.begin('app:1', [])
  expect(() => owner.commit(next, '{')).toThrow('INVALID_ARGUMENT')
  expect(owner.state(gen)).toBe('{"revision":1}')
  owner.dispose()
  await flush()
})

test('configuration and permission arrays are bounded and ignore custom iterators', async () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 1048577])
    expect(() => new ManagedGenerationOwner({ work: value })).toThrow('INVALID_ARGUMENT')
  const owner = new ManagedGenerationOwner()
  const permissions = ['window:use']
  permissions[Symbol.iterator] = function () {
    throw Error('should not be iterated')
  }
  const gen = owner.begin('app:1', permissions)
  permissions[0] = 'other'
  owner.attach(gen, owner.register(definition()), 'window:1')
  owner.retire(gen)
  expect(() => owner.begin('bad label', [])).toThrow('INVALID_ARGUMENT')
  expect(() => owner.begin('app:1', Array(65).fill('a'))).toThrow('INVALID_ARGUMENT')
  owner.dispose()
  await flush()
})

test('resource definitions snapshot methods once and reject reentrant closing during registration', async () => {
  const owner = new ManagedGenerationOwner()
  let calls = 0
  const source = definition({
    invoke: () => {
      calls++
      return 'null'
    },
  })
  const resource = owner.register(source),
    gen = active(owner, resource)
  Object.assign(source, {
    invoke: () => {
      throw Error('substitution')
    },
  })
  await owner.invoke(gen, resource, 'read', 'null')
  expect(calls).toBe(1)
  const malicious = Object.defineProperty(definition(), 'schema', {
    get() {
      owner.dispose()
      return 'window:1'
    },
  })
  expect(() => owner.register(malicious)).toThrow('DISPOSED')
  await flush()
})

test('adapter errors are fixed codes and resource accounting is released before successful caller settlement', async () => {
  const owner = new ManagedGenerationOwner()
  const resource = owner.register(
      definition({
        invoke: () => {
          throw Error('secret marker')
        },
      })
    ),
    gen = active(owner, resource)
  try {
    await owner.invoke(gen, resource, 'read', 'null')
    throw Error('expected failure')
  } catch (error) {
    expect(code('ADAPTER_FAILED')(error)).toBe(true)
    expect(String(error)).not.toContain('secret marker')
  }
  expect(owner.diagnostics().inFlight).toBe(0)
  const next = owner.begin('app:1', [])
  owner.commit(next, 'null')
  owner.dispose()
  await flush()
})

test('500 ownership-only replacements stay bounded without accumulating generation history', async () => {
  const owner = new ManagedGenerationOwner({ generations: 2, work: 8 }),
    resource = owner.register(definition())
  for (let i = 0; i < 500; i++) {
    const gen = owner.begin('app:1', ['window:use'])
    owner.attach(gen, resource, 'window:1')
    owner.own(gen, 'handler', () => {})
    owner.commit(gen, JSON.stringify({ revision: i }))
    expect(await owner.invoke(gen, resource, 'read', 'null')).toBe('null')
    await flush()
    expect(owner.diagnostics().generations).toBe(1)
    expect(owner.diagnostics().work).toBe(1)
  }
  owner.dispose()
  await flush()
  expect(
    owner.diagnostics().resources + owner.diagnostics().generations + owner.diagnostics().work
  ).toBe(0)
})

test('stable adapters run in the captured host context when called from a disposable graph', async () => {
  const owner = new ManagedGenerationOwner()
  let ranAsHost = false
  let server: ReturnType<typeof Bun.serve> | undefined
  const resource = owner.register(
    definition({
      invoke: () => {
        ranAsHost = Bun.ModuleGraph.current === undefined
        server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('stable') })
        return 'null'
      },
      dispose: () => {
        server?.stop(true)
      },
    })
  )
  const gen = active(owner, resource),
    scope = owner.scope(gen)
  const graph = new Bun.ModuleGraph()
  try {
    expect(() => graph.run(() => new ManagedGenerationOwner())).toThrow('INVALID_ARGUMENT')
    await graph.run(() => scope.invoke(resource, 'open', 'null'))
    graph.dispose()
    expect(ranAsHost).toBe(true)
    expect(await (await fetch(`http://127.0.0.1:${server!.port}/`)).text()).toBe('stable')
  } finally {
    graph.dispose()
    owner.dispose()
    await flush()
  }
})

test('limits object is immutable to callers after construction', () => {
  const limits = { resources: 1 }
  const owner = new ManagedGenerationOwner(limits)
  limits.resources = 2
  owner.register(definition())
  expect(() => owner.register(definition())).toThrow('CAPACITY')
  owner.dispose()
})

test('dependency-aware disposal releases views before windows and sessions', async () => {
  const owner = new ManagedGenerationOwner(),
    order: string[] = []
  const session = owner.register(
    definition({
      kind: 'session',
      dispose: () => {
        order.push('session')
      },
    })
  )
  const window = owner.register(
    definition({
      kind: 'window',
      dispose: () => {
        order.push('window')
      },
    })
  )
  const view = owner.register(
    definition({
      kind: 'view',
      dependsOn: [session, window],
      dispose: () => {
        order.push('view')
      },
    })
  )
  owner.dispose()
  await owner.disposeResource(view)
  await owner.disposeResource(session)
  await owner.disposeResource(window)
  expect(order[0]).toBe('view')
  expect(new Set(order)).toEqual(new Set(['view', 'session', 'window']))
  expect(owner.diagnostics().resources).toBe(0)
})

test('a failed dependent cleanup retains its parent until explicit retry succeeds', async () => {
  const owner = new ManagedGenerationOwner()
  let fails = true,
    parentReleased = false
  const parent = owner.register(
    definition({
      dispose: () => {
        parentReleased = true
      },
    })
  )
  const child = owner.register(
    definition({
      dependsOn: [parent],
      dispose: () => {
        if (fails) throw Error('denied')
      },
    })
  )
  owner.dispose()
  await expect(owner.disposeResource(child)).rejects.toThrow('CLEANUP_FAILED')
  expect(parentReleased).toBe(false)
  expect(owner.diagnostics().resources).toBe(2)
  fails = false
  owner.retryFailed()
  await owner.disposeResource(parent)
  expect(parentReleased).toBe(true)
  expect(owner.diagnostics().resources).toBe(0)
})

test('dependency admission rejects foreign, closing and duplicate identities', async () => {
  const owner = new ManagedGenerationOwner(),
    other = new ManagedGenerationOwner()
  const parent = owner.register(definition()),
    foreign = other.register(definition())
  expect(() => owner.register(definition({ dependsOn: [foreign] }))).toThrow('INVALID_IDENTITY')
  expect(() => owner.register(definition({ dependsOn: [parent, parent] }))).toThrow(
    'INVALID_ARGUMENT'
  )
  const disposal = owner.disposeResource(parent)
  expect(() => owner.register(definition({ dependsOn: [parent] }))).toThrow('INVALID_IDENTITY')
  await disposal
  owner.dispose()
  other.dispose()
  await flush()
})

test('repeated resource closure cannot retain attachment tombstones in a live generation', async () => {
  const owner = new ManagedGenerationOwner({ resources: 1 }),
    gen = owner.begin('app:1', ['window:use'])
  owner.commit(gen, 'null')
  for (let i = 0; i < 100; i++) {
    const resource = owner.register(definition())
    owner.attach(gen, resource, 'window:1')
    await owner.disposeResource(resource)
    expect(owner.diagnostics().attachments).toBe(0)
    expect(owner.diagnostics().resources).toBe(0)
  }
  owner.dispose()
})

test('the executable mock example preserves document identity and removes old event handlers', async () => {
  const { managedGenerationExample } = await import('../examples/managed-generations/main.ts')
  expect(await managedGenerationExample()).toEqual({
    profile: 'portable-managed-ownership-model',
    replacements: 1,
    nativeExecution: false,
    stableViewPreserved: true,
    oldCallbacks: 0,
    newCallbacks: 1,
  })
})

test('late external listener delivery is suppressed without throwing through EventTarget', async () => {
  const owner = new ManagedGenerationOwner(),
    gen = owner.begin('app:1', []),
    bus = new EventTarget()
  owner.commit(gen, 'null')
  let calls = 0
  const work = owner.own(gen, 'listener', () => {})
  const guarded = owner.callback(gen, work, () => {
    calls++
  })
  bus.addEventListener('event', guarded)
  owner.retire(gen)
  expect(() => bus.dispatchEvent(new Event('event'))).not.toThrow()
  expect(calls).toBe(0)
  bus.removeEventListener('event', guarded)
  owner.dispose()
  await flush()
})

test('a mistaken async authorizer is denied without invoking the adapter or leaking rejection', async () => {
  const owner = new ManagedGenerationOwner()
  let calls = 0
  const resource = owner.register(
    definition({
      authorize: (() =>
        Promise.reject(
          Error('private authorization detail')
        )) as unknown as ManagedResourceDefinition['authorize'],
      invoke: () => {
        calls++
        return 'null'
      },
    })
  )
  const gen = active(owner, resource)
  await expect(owner.invoke(gen, resource, 'read', 'null')).rejects.toThrow('DENIED')
  await flush()
  expect(calls).toBe(0)
  expect(owner.diagnostics().work).toBe(0)
  owner.dispose()
  await flush()
})

test('a generation scope never exposes owner registration, attachment or activation authority', async () => {
  const owner = new ManagedGenerationOwner(),
    gen = owner.begin('app:1', [])
  const scope = owner.scope(gen)
  expect(Object.isFrozen(scope)).toBe(true)
  expect(Object.keys(scope).sort()).toEqual([
    'callback',
    'generation',
    'invoke',
    'own',
    'release',
    'signal',
    'state',
  ])
  expect(Object.keys(gen)).toEqual([])
  owner.dispose()
  await flush()
})

test('invalid async authorization cannot escape capacity while its work remains pending', async () => {
  const owner = new ManagedGenerationOwner({ work: 1 }),
    pending = gate<boolean>()
  const resource = owner.register(
    definition({
      authorize: (() => pending.promise) as unknown as ManagedResourceDefinition['authorize'],
    })
  )
  const gen = active(owner, resource)
  await expect(owner.invoke(gen, resource, 'read', 'null')).rejects.toThrow('DENIED')
  expect(owner.diagnostics().inFlight).toBe(1)
  await expect(owner.invoke(gen, resource, 'read', 'null')).rejects.toThrow('CAPACITY')
  const next = owner.begin('app:1', [])
  expect(() => owner.commit(next, 'null')).toThrow('BUSY')
  pending.resolve(true)
  await flush()
  expect(owner.diagnostics().inFlight).toBe(0)
  owner.dispose()
  await flush()
})

test('detach cancellation only visits work from the retired attachment epoch', async () => {
  const owner = new ManagedGenerationOwner(),
    pending = gate<string>()
  let replacement: Promise<string> | undefined
  let calls = 0
  const resource = owner.register(
    definition({
      invoke: (operation, _input, context) => {
        calls++
        if (operation === 'replacement') return '"new"'
        context.signal.addEventListener(
          'abort',
          () => {
            owner.attach(generation, resource, 'window:1')
            replacement = owner.invoke(generation, resource, 'replacement', 'null')
            void replacement.catch(() => {})
          },
          { once: true }
        )
        return pending.promise
      },
    })
  )
  const generation = active(owner, resource)
  const original = owner.invoke(generation, resource, 'original', 'null')
  try {
    await flush()
    owner.detach(generation, resource)
    await expect(original).rejects.toThrow('RETIRED')
    expect(replacement).toBeDefined()
    expect(await replacement).toBe('"new"')
    expect(calls).toBe(2)
    // Old adapter ownership remains charged, although the newly attached call completed.
    expect(owner.diagnostics().inFlight).toBe(1)
  } finally {
    pending.resolve('"old"')
    owner.dispose()
    await flush()
  }
  expect(owner.diagnostics().work).toBe(0)
  expect(owner.diagnostics().resources).toBe(0)
})

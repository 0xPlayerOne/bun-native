import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  APPLICATION_LINK_LIMITS,
  matchesApplicationLinkRoute,
  normalizeApplicationLinksManifest,
  normalizeApplicationLinkUrl,
  normalizeExternalHttpsUrl,
  type ApplicationLinkBatch,
  type ApplicationLinkReader,
  type PolicyScope,
} from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { ManagedDesktopResources } from '../packages/runtime/src/managed-desktop.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const code = (expected: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === expected
const url = 'bunly-test://open/item?value=untrusted%20input'
const manifest = { schema: 1, routes: [{ scheme: 'bunly-test', host: 'open', path: '/item' }] }

async function fixture(supported = true, maxEvents = 64) {
  const peer = await nativePeer({
    desktopCapabilities: {
      version: 1,
      capabilities: supported ? ['app.links', 'app.open-url', 'app.lifecycle'] : ['app.lifecycle'],
    },
  })
  let next = 0,
    birth = 0,
    receipt = 0,
    granted = false
  let reader: { token: string; birth: number } | undefined
  let read: { id: number; through: number } | undefined
  let queue = [{ sequence: 1, url, source: 'startup' }]
  let intercept: ((command: Command) => boolean) | undefined
  const deliver = (command: Command) => {
    if (intercept?.(command)) return
    const scope = command.args['scope'] as { view: number } | undefined
    if (command.op === 'policy.scope')
      peer.reply(command, {
        view: Number(command.args['id']),
        session: 1,
        generation: 1,
        mainFrame: 'frame',
        document: 'native-3-1',
        origin: 'app://ui',
      })
    else if (command.op === 'policy.native.grant') {
      granted = (command.args['capability'] as { name: string }).name === 'application-links'
      peer.reply(command)
    } else if (command.op === 'links.create') {
      if (!granted || scope?.view !== 3) peer.reject(command, 'PERMISSION_DENIED: missing grant')
      else if (reader) peer.reject(command, 'RESOURCE_IN_USE: reader remains')
      else {
        reader = { token: String(command.args['registration']), birth: ++birth }
        peer.reply(command, { incarnation: birth })
      }
    } else if (command.op === 'links.dispose') {
      if (
        reader &&
        reader.token === command.args['registration'] &&
        reader.birth === command.args['incarnation']
      ) {
        reader = undefined
        read = undefined
      }
      peer.reply(command)
    } else if (command.op === 'links.read' || command.op === 'links.ack') {
      if (
        reader?.token !== command.args['registration'] ||
        reader?.birth !== command.args['incarnation']
      )
        peer.reject(command, 'DISPOSED: reader changed')
      else if (command.op === 'links.read') {
        read = { id: ++receipt, through: queue.at(-1)?.sequence ?? 0 }
        peer.reply(command, { receipt, links: queue, overflow: 0 })
      } else if (read?.id !== command.args['receipt'])
        peer.reject(command, 'INVALID_ARGUMENT: read changed')
      else {
        queue = queue.filter((link) => link.sequence > read!.through)
        read = undefined
        peer.reply(command)
      }
    } else if (command.op === 'app.open.url')
      peer.reject(command, 'PERMISSION_DENIED: missing URL grant')
    else
      peer.reply(
        command,
        ['window.create', 'view.create', 'session.create'].includes(command.op)
          ? { id: ++next }
          : null
      )
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  }
  peer.handle(deliver)
  const backend = new CefBackend(peer.transport)
  const session = await backend.createSession({ persistence: 'ephemeral', partition: 'links' })
  const window = await backend.createWindow({
    title: 'links',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const scope = await backend.capturePolicyScope(view)
  const owner = new ManagedGenerationOwner()
  const desktop = new ManagedDesktopResources(owner, backend, { maxEvents })
  return {
    ...peer,
    backend,
    owner,
    desktop,
    view,
    scope,
    deliver,
    grant: () => backend.grantNativeCapability(scope, { name: 'application-links' }),
    intercept(callback?: (command: Command) => boolean) {
      intercept = callback
    },
    queued: () => queue.length,
    async cleanup() {
      await desktop.dispose()
      owner.dispose()
      await backend.dispose()
    },
  }
}

test('application routes and HTTPS submissions require exact bounded canonical inputs', () => {
  const copy = structuredClone(manifest)
  const normalized = normalizeApplicationLinksManifest(copy)
  copy.routes[0]!.host = 'changed'
  assert.ok(Object.isFrozen(normalized.routes[0]))
  assert.equal(normalized.routes[0]?.host, 'open')
  assert.equal(normalizeApplicationLinkUrl(url), url)
  assert.equal(matchesApplicationLinkRoute(normalized, url), true)
  assert.equal(
    normalizeExternalHttpsUrl('https://example.com/path?q=one'),
    'https://example.com/path?q=one'
  )
  for (const bad of [
    null,
    [],
    {},
    { ...manifest, extra: true },
    { schema: 1, routes: [] },
    { schema: 1, routes: Array(9).fill(manifest.routes[0]) },
    { schema: 1, routes: [...manifest.routes, ...manifest.routes] },
  ])
    assert.throws(() => normalizeApplicationLinksManifest(bad), code('INVALID_ARGUMENT'))
  for (const bad of [
    'BUNLY-TEST://open/item',
    'bunly-test://Open/item',
    'bunly-test://open:80/item',
    'bunly-test://open/%69tem',
    'bunly-test://open/x/../item',
    'bunly-test://u@open/item',
    'bunly-test://open/item#',
    'bunly-test://open/item\n',
    'bunly-test://open/item?q=%xx',
    'bunly-test://open/item?' + 'a'.repeat(APPLICATION_LINK_LIMITS.urlBytes),
    'https://open/item',
  ])
    assert.throws(() => normalizeApplicationLinkUrl(bad), code('INVALID_ARGUMENT'))
  assert.equal(matchesApplicationLinkRoute(normalized, 'bunly-test://open/other'), false)
  for (const bad of [
    'http://example.com/',
    'https://example.com',
    'https://u:p@example.com/',
    'javascript:alert(1)',
    'https://example.com/#fragment',
    'https://example.com/\\evil',
    'https://example.com/%xx',
  ])
    assert.throws(() => normalizeExternalHttpsUrl(bad), code('INVALID_ARGUMENT'))
})

test('only the exact native-granted reader and latest authentic batch can consume queued links', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.backend.createApplicationLinkReader(f.scope), code('PERMISSION_DENIED'))
    assert.equal(f.backend.applicationLinkDiagnostics().readers, 0)
    await f.grant()
    await assert.rejects(
      f.backend.createApplicationLinkReader({} as PolicyScope),
      code('PERMISSION_DENIED')
    )
    const reader = await f.backend.createApplicationLinkReader(f.scope)
    await assert.rejects(
      f.backend.readApplicationLinks({ ...reader } as ApplicationLinkReader),
      code('INVALID_HANDLE')
    )
    await assert.rejects(f.backend.createApplicationLinkReader(f.scope), code('RESOURCE_IN_USE'))
    const first = await f.backend.readApplicationLinks(reader)
    const second = await f.backend.readApplicationLinks(reader)
    assert.ok(Object.isFrozen(second.links[0]))
    assert.equal(second.links[0]?.url, url)
    await assert.rejects(
      f.backend.acknowledgeApplicationLinks(reader, first),
      code('INVALID_ARGUMENT')
    )
    await assert.rejects(
      f.backend.acknowledgeApplicationLinks(reader, { ...second } as ApplicationLinkBatch),
      code('INVALID_ARGUMENT')
    )
    assert.equal(f.queued(), 1)
    await f.backend.acknowledgeApplicationLinks(reader, second)
    await assert.rejects(
      f.backend.acknowledgeApplicationLinks(reader, second),
      code('INVALID_ARGUMENT')
    )
    assert.equal(f.queued(), 0)
    await f.backend.disposeApplicationLinkReader(reader)
    await f.backend.disposeApplicationLinkReader(reader)
    assert.deepEqual(f.backend.applicationLinkDiagnostics(), { readers: 0 })
  } finally {
    await f.cleanup()
  }
})

test('reader disposal preserves pending entries and holds capacity through native cleanup', async () => {
  const f = await fixture()
  try {
    await f.grant()
    const reader = await f.backend.createApplicationLinkReader(f.scope)
    await f.backend.readApplicationLinks(reader)
    let disposal: Command | undefined
    f.intercept((command) => {
      if (command.op !== 'links.dispose') return false
      disposal = command
      return true
    })
    const disposing = f.backend.disposeApplicationLinkReader(reader)
    assert.equal(f.backend.disposeApplicationLinkReader(reader), disposing)
    await assert.rejects(f.backend.createApplicationLinkReader(f.scope), code('RESOURCE_IN_USE'))
    await assert.rejects(f.backend.readApplicationLinks(reader), code('DISPOSED'))
    f.intercept()
    // The retained peer owner is released only after this actual disposal reply.
    f.deliver(disposal!)
    await disposing
    assert.equal(f.queued(), 1)
    assert.deepEqual(f.backend.applicationLinkDiagnostics(), { readers: 0 })
  } finally {
    await f.cleanup()
  }
})

test('aborted pending reader creation waits for its native incarnation and cleanup acknowledgment', async () => {
  const f = await fixture()
  try {
    await f.grant()
    let creation: Command | undefined, disposal: Command | undefined
    f.intercept((command) => {
      if (command.op === 'links.create') {
        creation = command
        return true
      }
      if (command.op === 'links.dispose') {
        disposal = command
        return true
      }
      return false
    })
    const controller = new AbortController()
    const creating = f.backend.createApplicationLinkReader(f.scope, { signal: controller.signal })
    const rejected = assert.rejects(creating, /AbortError|aborted/)
    controller.abort()
    assert.equal(f.backend.applicationLinkDiagnostics().readers, 1)
    f.reply(creation!, { incarnation: 1 })
    await turn()
    assert.ok(disposal)
    assert.equal(disposal.args['incarnation'], 1)
    assert.equal(f.backend.applicationLinkDiagnostics().readers, 1)
    f.reply(disposal)
    await rejected
    assert.equal(f.backend.applicationLinkDiagnostics().readers, 0)
  } finally {
    await f.cleanup()
  }
})

test('navigation and native close revoke reader authority and preserve pending input', async () => {
  for (const reason of ['navigation', 'close'] as const) {
    const f = await fixture()
    try {
      await f.grant()
      const reader = await f.backend.createApplicationLinkReader(f.scope)
      const batch = await f.backend.readApplicationLinks(reader)
      if (reason === 'navigation') await f.backend.navigate(f.view, 'app://ui/index.html?next')
      else await f.backend.disposeView(f.view)
      await turn()
      await assert.rejects(f.backend.acknowledgeApplicationLinks(reader, batch), code('DISPOSED'))
      assert.equal(f.queued(), 1)
      assert.equal(f.backend.applicationLinkDiagnostics().readers, 0)
    } finally {
      await f.cleanup()
    }
  }
})

test('malformed native admissions, URLs, ordering and acknowledgments retain failed owners', async () => {
  for (const kind of ['create', 'url', 'order', 'bytes', 'ack', 'dispose'] as const) {
    const f = await fixture()
    await f.grant()
    if (kind === 'create') {
      f.intercept((command) => {
        if (command.op !== 'links.create') return false
        f.reply(command, { incarnation: 0 })
        return true
      })
      await assert.rejects(f.backend.createApplicationLinkReader(f.scope), /Malformed/)
    } else {
      const reader = await f.backend.createApplicationLinkReader(f.scope)
      if (kind === 'ack' || kind === 'dispose') {
        const batch = await f.backend.readApplicationLinks(reader)
        f.intercept((command) => {
          if (command.op !== 'links.' + kind) return false
          f.reply(command, {})
          return true
        })
        await assert.rejects(
          kind === 'ack'
            ? f.backend.acknowledgeApplicationLinks(reader, batch)
            : f.backend.disposeApplicationLinkReader(reader),
          /Malformed/
        )
      } else {
        f.intercept((command) => {
          if (command.op !== 'links.read') return false
          const links =
            kind === 'order'
              ? [
                  { sequence: 2, url, source: 'startup' },
                  { sequence: 1, url, source: 'startup' },
                ]
              : kind === 'bytes'
                ? Array.from({ length: 16 }, (_, index) => ({
                    sequence: index + 1,
                    url: 'bunly-test://open/item?' + 'a'.repeat(1800),
                    source: 'startup',
                  }))
                : [{ sequence: 1, url: 'file:///private/input', source: 'startup' }]
          f.reply(command, { receipt: 1, links, overflow: 0 })
          return true
        })
        await assert.rejects(f.backend.readApplicationLinks(reader), /Malformed/)
      }
    }
    await assert.rejects(f.backend.closed, /Malformed/)
    assert.equal(f.backend.applicationLinkDiagnostics().readers, 1)
    await assert.rejects(f.cleanup())
  }
})

test('managed generations retain input before destructive native ACK and replay without duplicate delivery', async () => {
  const f = await fixture()
  try {
    await f.grant()
    const reader = await f.backend.createApplicationLinkReader(f.scope)
    const resource = f.desktop.registerApplicationLinks('links', reader, {
      authority: await f.desktop.captureAuthority(f.view),
      permission: 'links',
      operations: ['events', 'ack-events'],
    })
    const bindings = await f.desktop.prepare()
    const begin = () => {
      const generation = f.owner.begin('links:1', ['links'])
      f.owner.attach(generation, resource, bindings['links']!.schema)
      f.owner.commit(generation, '{}')
      return f.owner.scope(generation)
    }
    const first = begin()
    let acknowledgment: Command | undefined
    f.intercept((command) => {
      if (command.op !== 'links.ack') return false
      acknowledgment = command
      return true
    })
    const pending = first.invoke(resource, 'events', 'null')
    const retired = assert.rejects(pending, /RETIRED/)
    for (let attempt = 0; attempt < 100 && !acknowledgment; attempt++) await turn()
    assert.ok(acknowledgment, JSON.stringify(f.commands))
    assert.equal(f.desktop.diagnostics().queuedEvents, 1)
    f.owner.retire(first.generation)
    await retired
    assert.equal(f.desktop.diagnostics().queuedEvents, 1)
    f.intercept()
    f.deliver(acknowledgment)
    await f.owner.whenIdle()
    const second = begin()
    assert.throws(() => f.owner.scope(first.generation), /RETIRED/)
    await assert.rejects(first.invoke(resource, 'ack-events', '{"through":1}'), /RETIRED/)
    assert.equal(f.queued(), 0)
    await assert.rejects(second.invoke(resource, 'ack-events', '{"through":1}'), /INVALID_ARGUMENT/)
    const events = JSON.parse(await second.invoke(resource, 'events', 'null')) as unknown[]
    assert.deepEqual(events, [
      { sequence: 1, type: 'link', state: { sequence: 1, url, source: 'startup' } },
    ])
    await second.invoke(resource, 'ack-events', '{"through":1}')
    assert.deepEqual(JSON.parse(await second.invoke(resource, 'events', 'null')), [])
    assert.equal(f.desktop.diagnostics().resources, 1)
  } finally {
    await f.cleanup()
  }
})

test('managed journal capacity does not acknowledge input that cannot fit', async () => {
  const f = await fixture(true, 1)
  try {
    await f.grant()
    const reader = await f.backend.createApplicationLinkReader(f.scope)
    const resource = f.desktop.registerApplicationLinks('links', reader, {
      authority: await f.desktop.captureAuthority(f.view),
      permission: 'links',
      operations: ['events', 'ack-events'],
    })
    const bindings = await f.desktop.prepare()
    const generation = f.owner.begin('links:1', ['links'])
    f.owner.attach(generation, resource, bindings['links']!.schema)
    f.owner.commit(generation, '{}')
    f.intercept((command) => {
      if (command.op !== 'links.read') return false
      f.reply(command, {
        receipt: 1,
        links: [{ sequence: 1, url, source: 'startup' }],
        overflow: 1,
      })
      return true
    })
    await assert.rejects(f.owner.scope(generation).invoke(resource, 'events', 'null'), /CAPACITY/)
    assert.equal(f.queued(), 1)
    assert.equal(f.desktop.diagnostics().queuedEvents, 0)
    assert.equal(
      f.commands.some((command) => command.op === 'links.ack'),
      false
    )
  } finally {
    await f.cleanup()
  }
})

test('failed native ACK retries the same receipt without duplicating stable journal entries', async () => {
  const f = await fixture()
  try {
    await f.grant()
    const reader = await f.backend.createApplicationLinkReader(f.scope)
    const resource = f.desktop.registerApplicationLinks('links', reader, {
      authority: await f.desktop.captureAuthority(f.view),
      permission: 'links',
      operations: ['events', 'ack-events'],
    })
    const bindings = await f.desktop.prepare()
    const generation = f.owner.begin('links:1', ['links'])
    f.owner.attach(generation, resource, bindings['links']!.schema)
    f.owner.commit(generation, '{}')
    f.intercept((command) => {
      if (command.op !== 'links.ack') return false
      f.reject(command, 'RESOURCE_IN_USE: transient native rejection')
      return true
    })
    await assert.rejects(
      f.owner.scope(generation).invoke(resource, 'events', 'null'),
      /ADAPTER_FAILED/
    )
    assert.equal(f.queued(), 1)
    assert.equal(f.desktop.diagnostics().queuedEvents, 1)
    f.intercept()
    const events = JSON.parse(
      await f.owner.scope(generation).invoke(resource, 'events', 'null')
    ) as unknown[]
    assert.equal(events.length, 1)
    assert.equal(f.queued(), 0)
    const acknowledgments = f.commands.filter((command) => command.op === 'links.ack')
    assert.equal(acknowledgments[0]?.args['receipt'], acknowledgments[1]?.args['receipt'])
  } finally {
    await f.cleanup()
  }
})

test('unsupported hosts and denied external submissions do not claim an OS browser launch', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      f.backend.openExternalUrl(f.scope, 'https://example.com/path'),
      code('PERMISSION_DENIED')
    )
    const before = f.commands.length
    await assert.rejects(
      f.backend.openExternalUrl(f.scope, 'javascript:alert(1)'),
      code('INVALID_ARGUMENT')
    )
    assert.equal(f.commands.length, before)
  } finally {
    await f.cleanup()
  }
  const unsupported = await fixture(false)
  try {
    await assert.rejects(
      unsupported.backend.createApplicationLinkReader(unsupported.scope),
      code('UNSUPPORTED_CAPABILITY')
    )
    await assert.rejects(
      unsupported.backend.openExternalUrl(unsupported.scope, 'https://example.com/path'),
      code('UNSUPPORTED_CAPABILITY')
    )
    const mock = new MockBackend()
    await assert.rejects(
      mock.createApplicationLinkReader({} as PolicyScope),
      code('UNSUPPORTED_CAPABILITY')
    )
    await mock.dispose()
  } finally {
    await unsupported.cleanup()
  }
})

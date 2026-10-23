import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  normalizeSessionNetworkPolicy,
  type SessionNetworkPolicy,
} from '../packages/contracts/src/index.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { nativePeer } from './helpers/native-peer.ts'

test('session network origins are exact, bounded, unique and copied', () => {
  const values = ['https://example.test', 'https://example.test:8443', 'http://127.0.0.1:43111']
  const normalized = normalizeSessionNetworkPolicy({ allowedOrigins: values })
  values.push('https://evil.test')
  assert.equal(normalized.allowedOrigins.length, 3)
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.allowedOrigins))
  for (const allowedOrigins of [
    ['https://example.test/'],
    ['https://EXAMPLE.test'],
    ['https://example.test:443'],
    ['https://example.test:0'],
    ['https://u:p@example.test'],
    ['https://*.example.test'],
    ['https://example.test/path'],
    ['https://example.test?x'],
    ['https://example.test#x'],
    ['http://example.test'],
    ['http://localhost:43111'],
    ['http://127.0.0.1'],
    ['http://127.0.0.1:0'],
    ['http://127.1:43111'],
    ['file:///'],
    ['app://ui'],
    ['null'],
    ['https://a.test', 'https://a.test'],
    [42],
    ['x'.repeat(257)],
    Array.from({ length: 33 }, (_, i) => `https://a${i}.test`),
  ])
    assert.throws(() => normalizeSessionNetworkPolicy({ allowedOrigins }), {
      code: 'INVALID_ARGUMENT',
    })
  for (const value of [
    null,
    undefined,
    [],
    {},
    { allowedOrigins: null },
    { allowedOrigins: [], extra: true },
  ])
    assert.throws(() => normalizeSessionNetworkPolicy(value), { code: 'INVALID_ARGUMENT' })
  assert.deepEqual(normalizeSessionNetworkPolicy({ allowedOrigins: [] }), { allowedOrigins: [] })
})

test('CEF passes only copied validated network policy to the native session owner', async () => {
  const peer = await nativePeer()
  const backend = new CefBackend(peer.transport)
  peer.handle((command) => {
    if (command.op === 'quit') {
      peer.reply(command)
      peer.send({ v: 1, event: 'shutdown' })
    }
  })
  try {
    const origins = ['https://allowed.test']
    const session = backend.createSession({
      persistence: 'ephemeral',
      partition: 'one',
      network: { allowedOrigins: origins },
    })
    origins.push('https://mutated.test')
    assert.deepEqual(peer.commands[0]!.args, {
      persistence: 'ephemeral',
      partition: 'one',
      network: { allowedOrigins: ['https://allowed.test'] },
    })
    peer.reply(peer.commands[0]!, { id: 1 })
    await session
    const count = peer.commands.length
    for (const network of [
      null,
      { allowedOrigins: ['http://arbitrary.test'] },
      { allowedOrigins: [], extra: true },
    ])
      await assert.rejects(
        backend.createSession({
          persistence: 'ephemeral',
          partition: 'invalid',
          network: network as unknown as SessionNetworkPolicy,
        }),
        { code: 'INVALID_ARGUMENT' }
      )
    assert.equal(peer.commands.length, count)
    const defaultSession = backend.createSession({ persistence: 'ephemeral', partition: 'default' })
    assert.equal(Object.hasOwn(peer.commands.at(-1)!.args, 'network'), false)
    peer.reply(peer.commands.at(-1)!, { id: 2 })
    await defaultSession
  } finally {
    await backend.dispose()
  }
})

test('mock never pretends to implement network enforcement', async () => {
  const backend = new MockBackend()
  try {
    await assert.rejects(
      backend.createSession({
        persistence: 'ephemeral',
        partition: 'network',
        network: { allowedOrigins: [] },
      }),
      { code: 'UNSUPPORTED_CAPABILITY' }
    )
  } finally {
    await backend.dispose()
  }
})

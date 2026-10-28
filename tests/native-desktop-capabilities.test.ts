import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { NativeTransport } from '../packages/runtime/src/native-transport.ts'
import { nativePeer } from './helpers/native-peer.ts'

test('native desktop capabilities and ready metadata are bounded immutable discovered values', async () => {
  const peer = await nativePeer()
  try {
    const ready = await peer.transport.ready
    const metadata = ready.data?.['desktopCapabilities'] as {
      version: number
      capabilities: string[]
    }
    assert.deepEqual(peer.transport.desktopCapabilities, [
      'window.state',
      'window.geometry',
      'clipboard.text',
      'app.lifecycle',
    ])
    assert.equal(metadata.version, 1)
    assert.deepEqual(metadata.capabilities, peer.transport.desktopCapabilities)
    assert.ok(Object.isFrozen(peer.transport.desktopCapabilities))
    assert.ok(Object.isFrozen(metadata))
    assert.ok(Object.isFrozen(metadata.capabilities))
    assert.throws(() => metadata.capabilities.push('view.composition'), TypeError)
    assert.throws(() => (metadata.version = 2), TypeError)
  } finally {
    await peer.stop()
  }
  const legacy = await nativePeer({ desktopCapabilities: undefined })
  try {
    assert.deepEqual(legacy.transport.desktopCapabilities, [])
    assert.ok(Object.isFrozen(legacy.transport.desktopCapabilities))
  } finally {
    await legacy.stop()
  }
})

test('malformed, duplicate or unknown desktop capability metadata closes the peer before admission', async () => {
  for (const desktopCapabilities of [
    null,
    [],
    {},
    { version: 2, capabilities: ['window.state'] },
    { version: 1, capabilities: 'window.state' },
    { version: 1, capabilities: ['window.state', 'window.state'] },
    { version: 1, capabilities: ['future.capability'] },
    { version: 1, capabilities: [1] },
    { version: 1, capabilities: ['window.state'], extra: true },
    { version: 1, capabilities: Array(17).fill('window.state') },
  ]) {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new NativeTransport(input, output)
    const events: unknown[] = []
    transport.onEvent((event) => events.push(event))
    assert.deepEqual(transport.desktopCapabilities, [])
    input.write(
      JSON.stringify({ v: 1, event: 'ready', abi: 1, data: { desktopCapabilities } }) + '\n'
    )
    await assert.rejects(transport.ready, /Native frame|native desktop capabilities/)
    await transport.closed
    await assert.rejects(transport.call('window.maximize', { id: 1 }), /not ready/)
    assert.deepEqual(transport.desktopCapabilities, [])
    assert.deepEqual(events, [])
    assert.equal(transport.diagnostics().requests, 0)
    assert.ok(input.destroyed)
    assert.ok(output.destroyed)
  }
})

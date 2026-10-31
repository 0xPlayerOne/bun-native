import { describe, expect, test } from 'bun:test'
import { NativeHost } from '@bun-native/runtime'
import { resolve } from 'node:path'

const fixture = resolve(import.meta.dir, 'protocol-peer.ts')
const options = (mode = 'normal', requestTimeoutMs = 1_000) => ({
  executable: process.execPath,
  args: [fixture, mode],
  requestTimeoutMs,
})

describe('native process transport (headless protocol peer)', () => {
  test('negotiates, opens, updates, receives ordered events, closes and tears down', async () => {
    const host = await NativeHost.launch(options())
    const events = host[Symbol.asyncIterator]()
    try {
      await host.send({ type: 'open', title: 'Test', text: 'Hello', input: '世界' })
      expect(await events.next()).toEqual({ done: false, value: { type: 'input', value: '世界' } })
      await host.send({ type: 'update', text: 'emit-click' })
      expect(await events.next()).toEqual({ done: false, value: { type: 'click' } })
      await host.send({ type: 'close' })
      expect(await events.next()).toEqual({ done: false, value: { type: 'closed' } })
    } finally {
      await host.shutdown()
    }
    expect(await host.exited).toBe(0)
    expect(await events.next()).toEqual({ done: true, value: undefined })
    await host.shutdown()
    await expect(host.send({ type: 'close' })).rejects.toThrow('not running')
  })

  test('command rejection preserves the healthy session', async () => {
    const host = await NativeHost.launch(options())
    try {
      await expect(host.send({ type: 'update', text: 'reject' })).rejects.toThrow('invalid_state')
      await host.send({ type: 'update', text: 'accepted' })
    } finally {
      await host.shutdown()
    }
    expect(await host.exited).toBe(0)
  })

  test('returning from the event iterator releases the owned native process', async () => {
    const host = await NativeHost.launch(options())
    const reader = host[Symbol.asyncIterator]()
    const waiting = reader.next()
    await reader.return?.()
    expect(await waiting).toEqual({ done: true, value: undefined })
    expect(await host.exited).toBe(0)
    expect(() => host[Symbol.asyncIterator]()).toThrow('exactly one consumer')
  })

  test.each(['wrong-version', 'bad-json', 'wrong-id', 'wrong-ack', 'duplicate-ready', 'exit'])(
    'rejects and reaps a host with %s',
    async (mode) => {
      await expect(NativeHost.launch(options(mode))).rejects.toThrow()
    }
  )

  test('bounds startup when the native process stops responding', async () => {
    await expect(NativeHost.launch(options('silent', 100))).rejects.toThrow('timed out')
  })

  test('rejects invalid options before spawning', async () => {
    await expect(NativeHost.launch({ executable: 'relative' })).rejects.toThrow('absolute')
    await expect(NativeHost.launch(options('normal', 0))).rejects.toThrow('requestTimeoutMs')
  })

  test('bounds an unconsumed event flood and terminates the native process', async () => {
    const host = await NativeHost.launch(options('flood'))
    await host.send({ type: 'open', title: 'Test', text: '', input: '' })
    await host.exited
    await expect(host.shutdown()).rejects.toThrow('event limit')
  })
})

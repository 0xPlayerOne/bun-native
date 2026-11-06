// Release-host boundary qualification for #247. Drives the actual native host
// over raw frames, bypassing the TypeScript client that cannot send these
// malformed or mismatched commands. Each case owns one fresh host process.
// With neither DISPLAY nor WAYLAND_DISPLAY, GPUI runs its headless platform:
// every protocol case still runs, and the real window case is left out.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseEvent,
  PROTOCOL_VERSION,
  type NativeEvent,
} from '@bun-native/protocol'
import assert from 'node:assert/strict'
import { networkInterfaces } from 'node:os'
import { isAbsolute } from 'node:path'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable || !isAbsolute(executable))
  throw new Error('BUN_NATIVE_HOST must name the absolute prebuilt native host')
const CASE_DEADLINE_MS = 10_000
const display = Boolean(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'])
const DISPLAY_CASES = new Set(['opens-and-closes-a-real-window'])

class RawHost {
  private readonly process = Bun.spawn([executable!], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  private readonly decoder = new FrameDecoder()
  private readonly reader = this.process.stdout.getReader()
  private readonly queued: NativeEvent[] = []
  private inputEnded = false

  async write(bytes: Uint8Array | string): Promise<void> {
    this.process.stdin.write(bytes)
    await this.process.stdin.flush()
  }

  send(value: unknown): Promise<void> {
    return this.write(encodeFrame(value))
  }

  /** Next event, or undefined once the host closes its output. */
  async next(): Promise<NativeEvent | undefined> {
    while (!this.queued.length) {
      const { done, value } = await this.reader.read()
      if (done) {
        this.decoder.finish()
        return undefined
      }
      for (const raw of this.decoder.push(value)) this.queued.push(parseEvent(raw))
    }
    return this.queued.shift()
  }

  async expect(type: NativeEvent['type']): Promise<NativeEvent> {
    const event = await this.next()
    assert(event, `Native output closed while waiting for ${type}`)
    assert.equal(event.type, type, `Expected ${type}, got ${JSON.stringify(event)}`)
    return event
  }

  async expectError(id: number | undefined, code: string): Promise<void> {
    const event = await this.expect('error')
    assert(event.type === 'error')
    assert.equal(event.id, id)
    assert.equal(event.code, code, event.message)
  }

  async hello(id: number): Promise<void> {
    await this.send({ id, type: 'hello', protocol: PROTOCOL_VERSION })
    const ready = await this.expect('ready')
    assert(ready.type === 'ready' && ready.protocol === PROTOCOL_VERSION)
    assert.deepEqual(await this.expect('ack'), { type: 'ack', id })
  }

  /** A healthy session acknowledges shutdown and exits 0. */
  async shutdown(id: number): Promise<number> {
    await this.send({ id, type: 'shutdown' })
    assert.deepEqual(await this.expect('ack'), { type: 'ack', id })
    this.endInput()
    return this.exit()
  }

  /** Closes the host's stdin: EOF on a frame boundary or inside a frame. */
  endInput(): void {
    if (this.inputEnded) return
    this.inputEnded = true
    this.process.stdin.end()
  }

  /** A terminal protocol failure or EOF closes output and exits without a shutdown. */
  async closedOutput(): Promise<number> {
    assert.equal(await this.next(), undefined, 'Native host kept writing after a terminal error')
    this.endInput()
    return this.exit()
  }

  private async exit(): Promise<number> {
    const code = await this.process.exited
    this.reader.releaseLock()
    return code
  }

  kill(): void {
    this.process.kill('SIGKILL')
  }
}

// Offline qualification runs this fixture inside an empty network namespace.
if (process.env['BUN_NATIVE_REQUIRE_OFFLINE'] === '1') {
  const external = Object.keys(networkInterfaces()).filter((name) => name !== 'lo')
  assert.deepEqual(external, [], 'Offline qualification requires an isolated network namespace')
}

const cases: Record<string, (host: RawHost) => Promise<Record<string, unknown>>> = {
  async 'opens-and-closes-a-real-window'(host) {
    await host.hello(1)
    await host.send({
      id: 2,
      type: 'open',
      window_id: 1,
      root_id: 1,
      title: 'Bun Native boundary',
      width: 320,
      height: 240,
    })
    assert.deepEqual(await host.expect('opened'), {
      type: 'opened',
      id: 2,
      window_id: 1,
      root_id: 1,
      tree_revision: 0,
    })
    await host.send({ id: 3, type: 'close', window_id: 1 })
    const closed = await host.expect('closed')
    assert(closed.type === 'closed' && closed.window_id === 1)
    assert.deepEqual(await host.expect('ack'), { type: 'ack', id: 3 })
    return { exit: await host.shutdown(4) }
  },
  async 'version-mismatch-is-recoverable'(host) {
    for (const [id, protocol] of [
      [1, PROTOCOL_VERSION + 1],
      [2, PROTOCOL_VERSION - 1],
      [3, 1],
    ] as const) {
      await host.send({ id, type: 'hello', protocol })
      await host.expectError(id, 'version_mismatch')
    }
    await host.hello(4)
    return { exit: await host.shutdown(5) }
  },
  async 'commands-before-hello-are-rejected'(host) {
    await host.send({ id: 1, type: 'close', window_id: 1 })
    await host.expectError(1, 'invalid_state')
    await host.hello(2)
    return { exit: await host.shutdown(3) }
  },
  async 'duplicate-hello-is-rejected'(host) {
    await host.hello(1)
    await host.send({ id: 2, type: 'hello', protocol: PROTOCOL_VERSION })
    await host.expectError(2, 'invalid_state')
    return { exit: await host.shutdown(3) }
  },
  async 'non-increasing-request-id-is-rejected'(host) {
    await host.hello(5)
    await host.send({ id: 5, type: 'shutdown' })
    await host.expectError(5, 'invalid_command')
    return { exit: await host.shutdown(6) }
  },
  async 'invalid-json-frame-is-terminal'(host) {
    await host.hello(1)
    await host.write('{bad json}\n')
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'forbidden-capability-frame-is-terminal'(host) {
    await host.hello(1)
    await host.send({ id: 2, type: 'read_file', path: '/etc/passwd' })
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'oversized-frame-is-terminal'(host) {
    await host.hello(1)
    await host.write('x'.repeat(DEFAULT_LIMITS.max_frame_bytes + 1))
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  // The frame limit counts bytes before the newline: exactly the limit is a
  // command, one byte more is a terminal failure even when it is terminated.
  async 'frame-at-the-byte-limit-is-accepted'(host) {
    await host.hello(1)
    await host.write(paddedFrame({ id: 2, type: 'shutdown' }, DEFAULT_LIMITS.max_frame_bytes))
    assert.deepEqual(await host.expect('ack'), { type: 'ack', id: 2 })
    host.endInput()
    return { exit: await host.closedOutput() }
  },
  async 'terminated-frame-over-the-byte-limit-is-terminal'(host) {
    await host.hello(1)
    await host.write(paddedFrame({ id: 2, type: 'shutdown' }, DEFAULT_LIMITS.max_frame_bytes + 1))
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'eof-inside-a-frame-is-terminal'(host) {
    await host.hello(1)
    await host.write(JSON.stringify({ id: 2, type: 'shutdown' }))
    host.endInput()
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'eof-before-hello-exits-without-output'(host) {
    host.endInput()
    return { exit: await host.closedOutput() }
  },
  async 'eof-after-version-mismatch-exits-without-negotiating'(host) {
    await host.send({ id: 1, type: 'hello', protocol: PROTOCOL_VERSION + 1 })
    await host.expectError(1, 'version_mismatch')
    host.endInput()
    return { exit: await host.closedOutput() }
  },
  async 'unknown-command-type-is-terminal'(host) {
    await host.hello(1)
    await host.send({ id: 2, type: 'teleport', window_id: 1 })
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'unknown-command-field-is-terminal'(host) {
    await host.hello(1)
    await host.send({ id: 2, type: 'shutdown', force: true })
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'non-numeric-hello-version-is-terminal-before-negotiation'(host) {
    await host.send({ id: 1, type: 'hello', protocol: String(PROTOCOL_VERSION) })
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'byte-order-mark-before-hello-is-terminal'(host) {
    await host.write(
      '﻿' + JSON.stringify({ id: 1, type: 'hello', protocol: PROTOCOL_VERSION }) + '\n'
    )
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'invalid-utf8-frame-is-terminal'(host) {
    await host.hello(1)
    const encoder = new TextEncoder()
    await host.write(
      Uint8Array.from([
        ...encoder.encode('{"id":2,"type":"open","window_id":1,"root_id":1,"title":"'),
        0xff,
        0xfe,
        ...encoder.encode('","width":320,"height":240}\n'),
      ])
    )
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'empty-frame-is-terminal'(host) {
    await host.hello(1)
    await host.write('\n')
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'frames-after-a-terminal-frame-are-not-executed'(host) {
    await host.hello(1)
    // One write: the valid shutdown behind the invalid frame must never ack.
    await host.write(
      Buffer.concat([Buffer.from('{bad json}\n'), encodeFrame({ id: 2, type: 'shutdown' })])
    )
    await host.expectError(undefined, 'invalid_command')
    return { exit: await host.closedOutput() }
  },
  async 'fragmented-and-coalesced-frames-are-reassembled'(host) {
    const stream = Buffer.concat([
      encodeFrame({ id: 1, type: 'hello', protocol: PROTOCOL_VERSION }),
      encodeFrame({ id: 2, type: 'shutdown' }),
    ])
    // Split inside the first frame, then deliver its tail with the next frame.
    for (const piece of [stream.subarray(0, 5), stream.subarray(5, 17), stream.subarray(17)]) {
      await host.write(piece)
      await Bun.sleep(20)
    }
    const ready = await host.expect('ready')
    assert(ready.type === 'ready' && ready.protocol === PROTOCOL_VERSION)
    assert.deepEqual(await host.expect('ack'), { type: 'ack', id: 1 })
    assert.deepEqual(await host.expect('ack'), { type: 'ack', id: 2 })
    host.endInput()
    return { exit: await host.closedOutput() }
  },
}

/** A valid command padded with JSON whitespace to exactly `bytes` before its newline. */
function paddedFrame(value: unknown, bytes: number): string {
  const json = JSON.stringify(value)
  assert(json.length <= bytes)
  return json + ' '.repeat(bytes - json.length) + '\n'
}

const results: Record<string, unknown>[] = []
for (const [name, run] of Object.entries(cases)) {
  if (!display && DISPLAY_CASES.has(name)) continue
  const host = new RawHost()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const started = performance.now()
    const result = await Promise.race([
      run(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} exceeded its deadline`)),
          CASE_DEADLINE_MS
        )
      }),
    ])
    assert.equal(result['exit'], 0, `${name} must end with a clean native exit`)
    results.push({ name, ...result, elapsedMs: Math.round(performance.now() - started) })
  } finally {
    clearTimeout(timer)
    host.kill()
  }
}
console.log(
  JSON.stringify({
    status: 'passed',
    protocol: PROTOCOL_VERSION,
    offline: process.env['BUN_NATIVE_REQUIRE_OFFLINE'] === '1',
    display,
    skipped: display ? [] : [...DISPLAY_CASES].map((name) => ({ name, reason: 'no display' })),
    results,
  })
)

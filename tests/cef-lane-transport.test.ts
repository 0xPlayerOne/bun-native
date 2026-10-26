import { expect, test } from 'bun:test'
import { CefLaneTransport } from '../packages/runtime/src/cef-lane-transport.ts'
import { FairWorkScheduler } from '../packages/runtime/src/fair-scheduler.ts'
import type { NativeTransport } from '../packages/runtime/src/native-transport.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture() {
  const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 2 })
  const calls: { op: string; args: Record<string, unknown> }[] = []
  let failure: string | undefined
  const native: Pick<NativeTransport, 'call'> = {
    call(op, args = {}) {
      calls.push({ op, args })
      if (op === failure) throw new Error('synchronous native failure')
      return Promise.resolve(null)
    },
  }
  const lane = (connection: number) =>
    new CefLaneTransport(native, { connection, context: 3, generation: 7 }, 'stream', scheduler, {})
  return {
    scheduler,
    calls,
    lane,
    fail: (op: string | undefined) => {
      failure = op
    },
  }
}
function outcome(promise: Promise<void>) {
  const state: { result: string; error?: unknown } = { result: 'pending' }
  void promise.then(
    () => {
      state.result = 'resolved'
    },
    (error: unknown) => {
      state.result = 'rejected'
      state.error = error
    }
  )
  return state
}

for (const transfer of [false, true]) {
  test(`scheduled native send owns the exact admitted slice (transfer: ${transfer})`, async () => {
    const f = fixture(),
      lane = f.lane(1)
    const buffer = new Uint8Array([99, 1, 2, 3, 88])
    const sent = outcome(lane.send(buffer.subarray(1, 4)))
    if (transfer) structuredClone(buffer.buffer, { transfer: [buffer.buffer] })
    else buffer.fill(42)
    await turn()
    expect(sent.result).toBe('resolved')
    expect(f.calls).toEqual([
      {
        op: 'stream.deliver',
        args: { connection: 1, context: 3, generation: 7, packet: '010203' },
      },
    ])
    lane.end(false)
    expect(f.scheduler.diagnostics()).toMatchObject({
      queueDepth: 0,
      owners: 0,
      yieldPending: false,
    })
  })
}

test('synchronous native submit failure rejects owned send, disconnects the lane and leaves peers live', async () => {
  const f = fixture(),
    lane = f.lane(1),
    peer = f.lane(2)
  let closed = 0
  lane.subscribe(
    () => {},
    () => closed++
  )
  f.fail('stream.deliver')
  const sent = outcome(lane.send(new Uint8Array([1])))
  await turn()
  f.fail(undefined)
  const peerSent = outcome(peer.send(new Uint8Array([2])))
  await turn()
  expect(sent.result).toBe('rejected')
  expect(String(sent.error)).toContain('synchronous native failure')
  expect(closed).toBe(1)
  expect(
    f.calls.some((call) => call.op === 'stream.disconnect' && call.args['connection'] === 1)
  ).toBe(true)
  expect(peerSent.result).toBe('resolved')
  lane.end(false)
  peer.end(false)
  expect(f.scheduler.diagnostics()).toMatchObject({ queueDepth: 0, owners: 0, yieldPending: false })
})

test('throwing receive callback deliberately disconnects without ACK and peer delivery progresses', async () => {
  const f = fixture(),
    lane = f.lane(1),
    peer = f.lane(2)
  let closed = 0,
    received = 0
  lane.subscribe(
    () => {
      throw new Error('consumer failed')
    },
    () => {
      closed++
      throw new Error('close observer failed')
    }
  )
  peer.subscribe(
    () => received++,
    () => {}
  )
  const queuedSend = outcome(lane.send(new Uint8Array([3])))
  lane.receive(new Uint8Array([1]), 1)
  peer.receive(new Uint8Array([2]), 1)
  for (let index = 0; index < 3; index++) await turn()
  expect(queuedSend.result).toBe('resolved')
  expect(closed).toBe(1)
  expect(received).toBe(1)
  expect(
    f.calls.filter((call) => call.op === 'stream.ack').map((call) => call.args['connection'])
  ).toEqual([2])
  expect(
    f.calls.some((call) => call.op === 'stream.disconnect' && call.args['connection'] === 1)
  ).toBe(true)
  lane.end(false)
  peer.end(false)
  expect(f.scheduler.diagnostics()).toMatchObject({ queueDepth: 0, owners: 0, yieldPending: false })
})

test('closing before dispatch cancels sends and receives without native handoff', async () => {
  const f = fixture(),
    lane = f.lane(1),
    peer = f.lane(2)
  let received = 0
  lane.subscribe(
    () => received++,
    () => {}
  )
  const sent = outcome(lane.send(new Uint8Array([1])))
  lane.receive(new Uint8Array([2]), 1)
  lane.close()
  const peerSent = outcome(peer.send(new Uint8Array([3])))
  await turn()
  expect(sent.result).toBe('rejected')
  expect(received).toBe(0)
  expect(f.calls.filter((call) => call.args['connection'] === 1).map((call) => call.op)).toEqual([
    'stream.disconnect',
  ])
  expect(peerSent.result).toBe('resolved')
  peer.end(false)
  expect(f.scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    bulkQueued: 0,
    controlQueued: 0,
    cancelled: 2,
    yieldPending: false,
  })
  const idle = f.scheduler.diagnostics()
  await turn()
  expect(f.scheduler.diagnostics()).toEqual(idle)
})

test('packet cap and malformed storage fail before scheduling; exact cap remains admitted', async () => {
  const f = fixture()
  for (const packet of [
    new Uint8Array(0),
    new Uint8Array(24 * 1024 + 1),
    new Uint8Array(new SharedArrayBuffer(1)),
  ]) {
    const lane = f.lane(1)
    const sent = outcome(lane.send(packet))
    await Promise.resolve()
    expect(sent.result).toBe('rejected')
  }
  expect(f.scheduler.diagnostics().enqueued).toBe(0)
  const lane = f.lane(2)
  await lane.send(new Uint8Array(24 * 1024))
  expect(String(f.calls.find((call) => call.op === 'stream.deliver')!.args['packet']).length).toBe(
    48 * 1024
  )
  lane.end(false)
})

test('synchronous ACK/disconnect failures still close locally and cancel queued work', async () => {
  const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 1 })
  const calls: string[] = []
  const native: Pick<NativeTransport, 'call'> = {
    call(op) {
      calls.push(op)
      throw new Error('native failed')
    },
  }
  const lane = new CefLaneTransport(
    native,
    { connection: 1, context: 1, generation: 1 },
    'stream',
    scheduler,
    {}
  )
  let closed = 0
  lane.subscribe(
    () => {},
    () => closed++
  )
  lane.receive(new Uint8Array([1]), 1)
  const sent = outcome(lane.send(new Uint8Array([2])))
  await turn()
  expect(sent.result).toBe('rejected')
  expect(closed).toBe(1)
  expect(calls).toEqual(['stream.ack', 'stream.disconnect'])
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    cancelled: 1,
    yieldPending: false,
  })
})

test('asynchronous submit failure disconnects once and cancels queued peers in that lane', async () => {
  const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 1 })
  const calls: string[] = []
  const native: Pick<NativeTransport, 'call'> = {
    call(op) {
      calls.push(op)
      return op === 'stream.deliver'
        ? Promise.reject(new Error('native rejected'))
        : Promise.resolve(null)
    },
  }
  const lane = new CefLaneTransport(
    native,
    { connection: 1, context: 1, generation: 1 },
    'stream',
    scheduler,
    {}
  )
  let closed = 0
  lane.subscribe(
    () => {},
    () => closed++
  )
  const first = outcome(lane.send(new Uint8Array([1])))
  const queued = outcome(lane.send(new Uint8Array([2])))
  await turn()
  expect(first.result).toBe('rejected')
  expect(queued.result).toBe('rejected')
  expect(closed).toBe(1)
  expect(calls).toEqual(['stream.deliver', 'stream.disconnect'])
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    cancelled: 1,
    yieldPending: false,
  })
})

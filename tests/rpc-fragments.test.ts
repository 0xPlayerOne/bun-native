import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  fragmentedRpcTransport,
  RpcFragmentBudget,
  NATIVE_RPC_CHUNK_BYTES,
  NATIVE_RPC_MESSAGE_BYTES,
} from '../packages/contracts/src/rpc-fragments.ts'
import type { RpcTransport } from '../packages/contracts/src/rpc.ts'

function link() {
  let message: ((packet: Uint8Array) => void) | undefined, closed: (() => void) | undefined
  const sent: Uint8Array[] = []
  let send: (packet: Uint8Array) => Promise<void> = async (packet) => {
    sent.push(new Uint8Array(packet))
  }
  let ends = 0
  const transport: RpcTransport = {
    send: (packet) => send(packet),
    subscribe: (receive, end) => {
      message = receive
      closed = end
      return () => {
        message = undefined
        closed = undefined
      }
    },
    close() {
      ends++
      const notify = closed
      closed = undefined
      message = undefined
      notify?.()
    },
  }
  return {
    transport,
    sent,
    setSend(value: typeof send) {
      send = value
    },
    receive(packet: Uint8Array) {
      message?.(packet)
    },
    end() {
      closed?.()
    },
    get ends() {
      return ends
    },
  }
}
function fragment(sequence: number, total: number, offset: number, length: number) {
  const packet = new Uint8Array(16 + length),
    view = new DataView(packet.buffer)
  view.setUint32(0, 0x424c4652)
  view.setUint32(4, sequence)
  view.setUint32(8, total)
  view.setUint32(12, offset)
  for (let i = 0; i < length; i++) packet[16 + i] = (offset + i) & 255
  return packet
}
test('native fragmentation roundtrips 64 KiB without raising process-message limits', async () => {
  const lower = link(),
    budget = new RpcFragmentBudget(),
    sender = fragmentedRpcTransport(lower.transport, budget)
  const destination = link(),
    receiver = fragmentedRpcTransport(destination.transport, budget)
  const received: Uint8Array[] = []
  receiver.subscribe(
    (packet) => received.push(new Uint8Array(packet)),
    () => {}
  )
  try {
    for (const size of [
      1,
      1024,
      NATIVE_RPC_CHUNK_BYTES,
      NATIVE_RPC_CHUNK_BYTES + 1,
      65536,
      NATIVE_RPC_MESSAGE_BYTES,
    ]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i & 255),
        copy = new Uint8Array(bytes)
      const sent = sender.send(bytes)
      bytes.fill(255)
      await sent
      for (const chunk of lower.sent.splice(0)) {
        assert.ok(chunk.length <= NATIVE_RPC_CHUNK_BYTES)
        destination.receive(chunk)
      }
      assert.deepEqual(received.pop(), copy)
      assert.equal(budget.diagnostics().retainedBytes, 0)
    }
  } finally {
    sender.close()
    receiver.close()
  }
})
test('malformed or replayed fragments cannot allocate beyond bounded declarations', () => {
  for (const [sequence, total, offset, length] of [
    [0, 65536, 0, NATIVE_RPC_CHUNK_BYTES - 16],
    [1, 0xffffffff, 0, 1],
    [1, 65536, 1, NATIVE_RPC_CHUNK_BYTES - 16],
    [1, 65536, 0, 1],
    [1, 24, 0, 1],
    [1, 65536, 65535, 2],
  ]) {
    const lower = link(),
      budget = new RpcFragmentBudget(),
      transport = fragmentedRpcTransport(lower.transport, budget)
    let closed = 0
    transport.subscribe(
      () => assert.fail('Malformed packet was delivered'),
      () => closed++
    )
    assert.throws(() => lower.receive(fragment(sequence!, total!, offset!, length!)))
    assert.equal(budget.diagnostics().retainedBytes, 0)
    assert.equal(closed, 1)
  }
  const lower = link(),
    budget = new RpcFragmentBudget(),
    transport = fragmentedRpcTransport(lower.transport, budget)
  transport.subscribe(
    () => {},
    () => {}
  )
  const first = fragment(1, 65536, 0, NATIVE_RPC_CHUNK_BYTES - 16)
  lower.receive(first)
  assert.equal(budget.diagnostics().retainedBytes, 65536)
  assert.throws(() => lower.receive(first))
  assert.equal(budget.diagnostics().retainedBytes, 0)
})
test('fragment budgets survive cross-connection pressure and return on partial cancellation', () => {
  const budget = new RpcFragmentBudget(NATIVE_RPC_MESSAGE_BYTES)
  const a = link(),
    b = link(),
    first = fragmentedRpcTransport(a.transport, budget),
    second = fragmentedRpcTransport(b.transport, budget)
  first.subscribe(
    () => {},
    () => {}
  )
  second.subscribe(
    () => {},
    () => {}
  )
  a.receive(fragment(1, 65536, 0, NATIVE_RPC_CHUNK_BYTES - 16))
  assert.throws(() => b.receive(fragment(1, 65536, 0, NATIVE_RPC_CHUNK_BYTES - 16)), /budget/)
  assert.equal(budget.diagnostics().retainedBytes, 65536)
  first.close()
  assert.equal(budget.diagnostics().retainedBytes, 0)
  const release = budget.reserve(NATIVE_RPC_MESSAGE_BYTES)
  assert.throws(() => budget.reserve(1))
  release()
  release()
  assert.equal(budget.diagnostics().retainedBytes, 0)
})
test('closing a stalled fragmented send settles once and drops full-message ownership', async () => {
  const lower = link(),
    budget = new RpcFragmentBudget(),
    transport = fragmentedRpcTransport(lower.transport, budget)
  let acknowledge!: () => void
  lower.setSend((packet) => {
    lower.sent.push(new Uint8Array(packet))
    return new Promise((resolve) => {
      acknowledge = resolve
    })
  })
  transport.subscribe(
    () => {},
    () => {}
  )
  const send = Promise.resolve(transport.send(new Uint8Array(65536)))
  await assert.rejects(Promise.resolve(transport.send(new Uint8Array(1))), { code: 'OVERLOADED' })
  assert.equal(budget.diagnostics().retainedBytes, 65536)
  transport.close()
  await assert.rejects(send, { code: 'DISCONNECTED' })
  assert.equal(budget.diagnostics().retainedBytes, 0)
  assert.equal(lower.sent.length, 1)
  acknowledge()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(lower.sent.length, 1)
  await assert.rejects(Promise.resolve(transport.send(new Uint8Array(1))), { code: 'DISCONNECTED' })
})
test('partial reassembly expires without retaining a timer or forwarding bytes', () => {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout
  let fire: (() => void) | undefined,
    clears = 0
  globalThis.setTimeout = ((callback: () => void) => {
    fire = callback
    return 1
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = (() => {
    clears++
  }) as typeof clearTimeout
  try {
    const lower = link(),
      budget = new RpcFragmentBudget(),
      transport = fragmentedRpcTransport(lower.transport, budget)
    let closed = 0
    transport.subscribe(
      () => assert.fail('Partial message delivered'),
      () => closed++
    )
    lower.receive(fragment(1, 65536, 0, NATIVE_RPC_CHUNK_BYTES - 16))
    fire!()
    assert.equal(closed, 1)
    assert.equal(clears, 1)
    assert.equal(budget.diagnostics().retainedBytes, 0)
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
})
test('fragment receiver retains its reservation across callback reentrancy', () => {
  const lower = link(),
    budget = new RpcFragmentBudget(NATIVE_RPC_MESSAGE_BYTES),
    transport = fragmentedRpcTransport(lower.transport, budget)
  transport.subscribe(
    () => {
      assert.equal(budget.diagnostics().retainedBytes, 65536)
      assert.throws(() => budget.reserve(65536))
      transport.close()
    },
    () => {}
  )
  let offset = 0
  while (offset < 65536) {
    const length = Math.min(NATIVE_RPC_CHUNK_BYTES - 16, 65536 - offset)
    lower.receive(fragment(1, 65536, offset, length))
    offset += length
  }
  assert.equal(budget.diagnostics().retainedBytes, 0)
})

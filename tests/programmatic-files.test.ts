import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'bun:test'
import { CefProgrammaticFiles } from '../packages/runtime/src/cef-programmatic-files.ts'
import { viewControlBudget } from '../packages/runtime/src/cef-view-control-budget.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'
import { PROGRAMMATIC_FILE_LIMITS as LIMITS } from '../packages/contracts/src/programmatic-files.ts'

const scope = {
  view: 4,
  session: 2,
  generation: 1,
  mainFrame: 'main',
  document: 'native-4-1',
  origin: 'http://127.0.0.1:8080',
}
const request = (bytes = new Uint8Array([1, 2, 3])) => ({
  kind: 'file-input' as const,
  elementId: 'upload',
  file: { name: 'fixture.bin', type: 'application/octet-stream', bytes },
})
const result = (status: 'completed' | 'cancelled' = 'cancelled') => ({
  status,
  failure: null,
  synthetic: true,
  mayHaveExposedFile: status === 'completed',
})
async function setup() {
  const peer = await nativePeer()
  const controller = new CefProgrammaticFiles(peer.transport)
  const budget = viewControlBudget(peer.transport)
  peer.transport.onEvent((event) => controller.event(event))
  void peer.transport.closed.then(() =>
    controller.close(peer.transport.failure ?? new Error('Closed'))
  )
  const ready = (id = 10) =>
    peer.send({ v: 1, event: 'file.interaction.ready', target: 4, data: { id } })
  const finish = (status: 'completed' | 'cancelled' = 'cancelled', id = 10) =>
    peer.send({
      v: 1,
      event: 'file.interaction.finished',
      target: 4,
      data: { id, result: result(status) },
    })
  return { peer, controller, budget, ready, finish }
}

test('staged files copy before native await, send bounded chunks, and expose only on explicit commit', async () => {
  const { peer, controller, budget, ready, finish } = await setup()
  const bytes = new Uint8Array(2 * LIMITS.chunkBytes + 13).map((_, index) => index % 251)
  const expected = Buffer.from(bytes)
  const chunks: Buffer[] = []
  peer.handle((command) => {
    if (command.op === 'file.interaction.prepare') {
      assert.equal(
        (command.args['metadata'] as { sha256: string }).sha256,
        createHash('sha256').update(expected).digest('hex')
      )
      assert.equal(budget.diagnostics().operations, 1)
      peer.reply(command, { id: 10 })
      ready()
    } else if (command.op === 'file.interaction.write') {
      const chunk = Buffer.from(String(command.args['hex']), 'hex')
      assert.ok(chunk.length > 0 && chunk.length <= LIMITS.chunkBytes)
      assert.equal(
        command.args['offset'],
        chunks.reduce((sum, value) => sum + value.length, 0)
      )
      chunks.push(chunk)
      peer.reply(command)
    } else if (command.op === 'file.interaction.commit') {
      peer.reply(command)
      finish('completed')
    }
  })
  try {
    const prepared = controller.prepare(4, scope, request(bytes), () => {})
    bytes.fill(0)
    const operation = await prepared
    assert.deepEqual(Buffer.concat(chunks), expected)
    assert.equal(chunks.length, 3)
    assert.equal(
      peer.commands.filter((command) => command.op === 'file.interaction.commit').length,
      0
    )
    assert.throws(() => controller.prepare(4, scope, request(), () => {}), /capacity/)
    const completed = operation.commit()
    assert.equal(operation.commit(), completed)
    assert.deepEqual(await completed, result('completed'))
    assert.equal(
      peer.commands.filter((command) => command.op === 'file.interaction.commit').length,
      1
    )
    assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
  } finally {
    await peer.stop()
  }
})

test('cancellation acknowledgement retains the operation until actual native cleanup', async () => {
  const { peer, controller, budget, ready, finish } = await setup()
  peer.handle((command) => {
    if (command.op === 'file.interaction.prepare') {
      peer.reply(command, { id: 10 })
      ready()
    } else peer.reply(command)
  })
  try {
    const operation = await controller.prepare(4, scope, request(), () => {})
    const cancelled = operation.cancel()
    await turn()
    assert.equal(budget.diagnostics().operations, 1)
    assert.throws(() => controller.prepare(4, scope, request(), () => {}), /capacity/)
    finish()
    assert.deepEqual(await cancelled, result())
    assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
  } finally {
    await peer.stop()
  }
})

test('a terminal native receipt cannot release bytes while a late chunk call still unwinds', async () => {
  const { peer, controller, budget, ready, finish } = await setup()
  const abort = new AbortController()
  let pending: Command | undefined
  peer.handle((command) => {
    if (command.op === 'file.interaction.prepare') {
      peer.reply(command, { id: 10 })
      ready()
    } else if (command.op === 'file.interaction.write') pending = command
    else if (command.op === 'file.interaction.cancel') {
      peer.reply(command)
      finish()
    }
  })
  const preparing = controller.prepare(
    4,
    scope,
    request(new Uint8Array(LIMITS.chunkBytes)),
    () => {},
    abort.signal
  )
  void preparing.catch(() => {})
  try {
    await turn()
    assert.ok(pending)
    abort.abort()
    await turn()
    assert.equal(budget.diagnostics().operations, 1)
    peer.reject(pending, 'PERMISSION_DENIED: cancelled chunk')
    await assert.rejects(preparing)
    assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
  } finally {
    await peer.stop()
  }
})

test('completed receipt waits for the matching commit acknowledgement before releasing quota', async () => {
  const { peer, controller, budget, ready, finish } = await setup()
  let commit: Command | undefined
  peer.handle((command) => {
    if (command.op === 'file.interaction.prepare') {
      peer.reply(command, { id: 10 })
      ready()
    } else if (command.op === 'file.interaction.commit') {
      commit = command
      finish('completed')
    } else peer.reply(command)
  })
  try {
    const operation = await controller.prepare(4, scope, request(), () => {})
    let settled = false
    const completed = operation.commit().then((value) => {
      settled = true
      return value
    })
    await turn()
    assert.ok(commit)
    assert.equal(settled, false)
    assert.equal(budget.diagnostics().operations, 1)
    peer.reply(commit)
    assert.deepEqual(await completed, result('completed'))
    assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
  } finally {
    await peer.stop()
  }
})

test('a malformed commit acknowledgement cannot publish an earlier completed receipt', async () => {
  const { peer, controller, budget, ready, finish } = await setup()
  let commit: Command | undefined
  peer.handle((command) => {
    if (command.op === 'file.interaction.prepare') {
      peer.reply(command, { id: 10 })
      ready()
    } else if (command.op === 'file.interaction.commit') {
      commit = command
      finish('completed')
    } else peer.reply(command)
  })
  const operation = await controller.prepare(4, scope, request(), () => {})
  const completed = operation.commit()
  void completed.catch(() => {})
  await turn()
  assert.ok(commit)
  peer.reply(commit, { unreviewed: true })
  await assert.rejects(completed, /acknowledgement/)
  await peer.transport.closed
  assert.ok(peer.transport.failure)
  assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
})

test('revoked local document authority cancels staged bytes without dispatch', async () => {
  const { peer, controller, budget, ready, finish } = await setup()
  let current = true
  peer.handle((command) => {
    if (command.op === 'file.interaction.prepare') {
      peer.reply(command, { id: 10 })
      ready()
    } else {
      peer.reply(command)
      if (command.op === 'file.interaction.cancel') finish()
    }
  })
  try {
    const operation = await controller.prepare(4, scope, request(), () => {
      if (!current) throw new Error('Stale document')
    })
    current = false
    assert.deepEqual(await operation.commit(), result())
    assert.equal(
      peer.commands.some((command) => command.op === 'file.interaction.commit'),
      false
    )
    assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
  } finally {
    await peer.stop()
  }
})

test('admission denial and malformed admission release only after failing the appropriate boundary', async () => {
  for (const malformed of [false, true]) {
    const { peer, controller, budget } = await setup()
    peer.handle((command) =>
      malformed
        ? peer.reply(command, { id: 10, extra: true })
        : peer.reject(command, 'PERMISSION_DENIED: fixture')
    )
    await assert.rejects(controller.prepare(4, scope, request(), () => {}))
    assert.equal(Boolean(peer.transport.failure), malformed)
    assert.deepEqual(budget.diagnostics(), { operations: 0, bytes: 0 })
    await peer.stop()
  }
})

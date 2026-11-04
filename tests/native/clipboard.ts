/** Real, isolated X11 selection transfers; the controller supplies OS input and closes the window. */
import {
  createApplication,
  NativeServiceError,
  NativeStateError,
  type NativeApplication,
} from '@bun-native/core'
import { NativeCommandError, NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const configuredHost = process.env['BUN_NATIVE_HOST']
const configuredPeer = process.env['BUN_NATIVE_CLIPBOARD_PEER']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (
  !directory ||
  !isAbsolute(directory) ||
  !statSync(directory).isDirectory() ||
  !configuredHost ||
  !isAbsolute(configuredHost) ||
  !configuredPeer ||
  !isAbsolute(configuredPeer) ||
  !nonce ||
  !/^[a-f\d]{32}$/u.test(nonce) ||
  process.env['BUN_NATIVE_DIAGNOSTICS_SCENARIO'] !== 'clipboard' ||
  process.env['BUN_NATIVE_ISOLATED_CLIPBOARD'] !== '1'
)
  throw new Error(
    'Explicit isolated clipboard diagnostic directory, host, peer and nonce are required'
  )
const output = directory
const executable = configuredHost
const peerExecutable = configuredPeer
const permissions = { clipboardRead: 'allow', clipboardWrite: 'allow' } as const
const started = performance.now()
const record = (type: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(
    join(output, 'application.jsonl'),
    JSON.stringify({ nonce, type, atMs: performance.now() - started, ...fields }) + '\n'
  )

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeout = 3_000
): Promise<T> {
  const until = performance.now() + timeout
  while (performance.now() < until) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(5)
  }
  throw new Error('Timed out waiting for ' + description)
}
async function step(name: string): Promise<void> {
  await waitFor(() => (existsSync(join(output, name)) ? true : undefined), name, 10_000)
}

interface PeerRecord {
  readonly nonce: string
  readonly label: string
  readonly pid: number
  readonly type: string
  readonly result?: unknown
}
interface Peer {
  readonly label: string
  readonly identity: Readonly<{ pid: number; startTicks: string }>
  records(): PeerRecord[]
  received(type: string): Promise<PeerRecord>
  stop(): Promise<void>
}
const peers: Peer[] = []
const peerResults: Array<{
  label: string
  identity: Peer['identity']
  exitCode: number
  records: PeerRecord[]
}> = []

async function peer(label: string, mode: string, text = ''): Promise<Peer> {
  assert(/^[a-z\d-]{1,40}$/u.test(label))
  const args =
    mode === 'read' || mode === 'malformed-multiple' ? [mode, label] : ['owner', label, mode, text]
  const path = join(output, `clipboard-${label}.jsonl`)
  const child = Bun.spawn([peerExecutable, ...args], {
    stdin: 'ignore',
    stdout: Bun.file(path),
    stderr: Bun.file(join(output, `clipboard-${label}.stderr.log`)),
  })
  let identity: Peer['identity']
  try {
    const stat = await waitFor(() => {
      const path = `/proc/${child.pid}/stat`
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    }, 'owned clipboard peer identity')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    assert.equal(Number(fields[1]), process.pid)
    const startTicks = fields[19]
    assert(startTicks && /^\d+$/u.test(startTicks))
    identity = Object.freeze({ pid: child.pid, startTicks })
    writeFileSync(join(output, `clipboard-${label}.start`), '')
  } catch (error) {
    child.kill('SIGKILL')
    await child.exited
    throw error
  }
  function records(): PeerRecord[] {
    if (!existsSync(path)) return []
    assert(statSync(path).size <= 65_536, 'Independent clipboard evidence exceeded its bound')
    const content = readFileSync(path, 'utf8')
    return content
      .slice(0, content.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const row: unknown = JSON.parse(line)
        assert(row && typeof row === 'object')
        const item = row as Record<string, unknown>
        assert.equal(item['nonce'], nonce)
        assert.equal(item['label'], label)
        assert.equal(item['pid'], child.pid)
        assert.equal(typeof item['type'], 'string')
        return row as PeerRecord
      })
  }
  let stopping: Promise<void> | undefined
  const result: Peer = {
    label,
    identity,
    records,
    received(type) {
      return waitFor(() => {
        const row = records().find((row) => row.type === type)
        if (row) return row
        if (child.exitCode !== null)
          throw new Error(`Clipboard peer ${label} exited before ${type}`)
        return undefined
      }, `${label}: ${type}`)
    },
    stop() {
      stopping ??= (async () => {
        let failure: unknown
        try {
          writeFileSync(join(output, `clipboard-${label}.stop`), '')
          await waitFor(
            () => (child.exitCode === null ? undefined : child.exitCode),
            `${label} exit`
          )
        } catch (error) {
          failure = error
          child.kill('SIGKILL')
        }
        const exitCode = await child.exited
        const rows = records()
        peerResults.push({ label, identity, exitCode, records: rows })
        record('peer-joined', { label, identity, exitCode })
        if (failure) throw failure
        assert.equal(exitCode, 0, 'Independent clipboard peer must terminate normally')
      })()
      return stopping
    },
  }
  peers.push(result)
  record('peer-created', { label, identity })
  return result
}
async function externalOwner(label: string, mode: string, text = ''): Promise<Peer> {
  const result = await peer(label, mode, text)
  await result.received('ready')
  return result
}
async function externalRead(label: string): Promise<unknown> {
  const result = await peer(label, 'read')
  try {
    return (await result.received('read')).result
  } finally {
    await result.stop()
  }
}
async function stopped(app: NativeApplication): Promise<void> {
  await app.shutdown()
  await app.closed
  assert(Object.values(app.diagnostics).every((count) => count === 0))
}
const errorCode = (code: NativeServiceError['code']) => (error: unknown) =>
  error instanceof NativeServiceError && error.code === code
const staleWindow = (error: unknown) =>
  error instanceof NativeStateError && error.code === 'invalid_handle'

const outcomes = {
  nativeDefaultDenial: false,
  nativeStaleAndUnknownOwners: false,
  pendingShutdownJoined: false,
  emptySelection: false,
  stalledTransferDeadline: false,
  inputAndCommitDuringTransfer: false,
  ordinary: false,
  delayed: false,
  incremental: false,
  'empty-text': false,
  oversize: false,
  'incr-oversize': false,
  'incr-header-large': false,
  'invalid-utf8': false,
  nul: false,
  drop: false,
  'slow-incr': false,
  flood: false,
  submittedReadCancellation: false,
  preDispatchCancellation: false,
  pendingWindowClose: false,
  externalReadOfWrite: false,
  malformedMultipleRejected: false,
  externalEmptyText: false,
  writeSurvivesWindowClose: false,
  shutdownPreservesNewExternalOwner: false,
}
let app: NativeApplication | undefined
let failure: Error | undefined
let inputCount = 0
try {
  const denied = await NativeHost.launch({ executable })
  try {
    await assert.rejects(
      denied.send({ type: 'clipboard_read', window_id: 1 }),
      (error: unknown) => error instanceof NativeCommandError && error.code === 'permission_denied'
    )
    await assert.rejects(
      denied.send({ type: 'clipboard_write', window_id: 1, text: 'denied' }),
      (error: unknown) => error instanceof NativeCommandError && error.code === 'permission_denied'
    )
    outcomes.nativeDefaultDenial = true
  } finally {
    await denied.shutdown()
    assert.equal(await denied.exited, 0)
  }

  const raw = await NativeHost.launch({ executable, permissions })
  try {
    await raw.send({
      type: 'open',
      window_id: 1,
      root_id: 1,
      title: 'Clipboard ownership control',
      width: 320,
      height: 200,
    })
    await raw.send({ type: 'close', window_id: 1 })
    for (const window_id of [1, 2])
      await assert.rejects(
        raw.send({ type: 'clipboard_read', window_id }),
        (error: unknown) => error instanceof NativeCommandError && error.code === 'invalid_handle'
      )
    outcomes.nativeStaleAndUnknownOwners = true
  } finally {
    await raw.shutdown()
    assert.equal(await raw.exited, 0)
  }

  const closing = await createApplication({ executable, permissions })
  let shutdownOwner: Peer | undefined
  try {
    shutdownOwner = await externalOwner('shutdown', 'stall')
    const window = await closing.openWindow({ title: 'Clipboard shutdown control' })
    const rejection = assert.rejects(window.readClipboardText(), staleWindow)
    await shutdownOwner.received('requested')
    await stopped(closing)
    await rejection
    assert(!existsSync(join(output, 'clipboard-shutdown.stop')))
    outcomes.pendingShutdownJoined = true
  } finally {
    try {
      await shutdownOwner?.stop()
    } finally {
      await stopped(closing)
    }
  }

  app = await createApplication({ executable, permissions })
  assert.deepEqual(app.serviceCapabilities.clipboardText, {
    availability: 'available',
    read: 'allow',
    write: 'allow',
    scope: 'owned_window',
    backend: 'x11',
  })
  const window = await app.openWindow({ title: 'Bun Native clipboard', width: 560, height: 320 })
  const { label, input } = await window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: {
        direction: 'column',
        padding: 24,
        gap: 12,
        background: 0xf4f5f7,
      },
    })
    const title = batch.create({
      kind: 'text',
      text: 'Bounded native clipboard',
      style: { height: 40, font_size: 26 },
    })
    const label = batch.create({ kind: 'text', text: 'Clipboard ready', style: { height: 32 } })
    const input = batch.create({
      kind: 'input',
      value: '',
      placeholder: 'Input remains responsive',
      style: { width: 'fill', height: 44, font_size: 22 },
    })
    batch.insert(window.root, title, 0)
    batch.insert(window.root, label, 1)
    batch.insert(window.root, input, 2)
    return { label, input }
  })
  let transferPending = false
  window.onInput(input, (event) => {
    inputCount++
    assert(transferPending, 'OS input must arrive while the external owner is still stalled')
    assert.equal(inputCount, 1)
    assert.equal(event.value, 'x')
    assert.equal(event.revision, 1)
    record('input-during-transfer', {
      pending: transferPending,
      value: event.value,
      revision: event.revision,
      sequence: event.sequence,
    })
  })
  record('mounted', { treeRevision: 1 })
  assert.deepEqual(await window.readClipboardText(), { kind: 'empty' })
  outcomes.emptySelection = true
  record('read-idle')
  await step('after-read-idle')

  const stalled = await externalOwner('responsive', 'stall')
  try {
    await step('start-stall')
    transferPending = true
    const requestedAt = performance.now()
    const transfer = window.readClipboardText().finally(() => {
      transferPending = false
    })
    const rejection = assert.rejects(transfer, errorCode('operation_timed_out'))
    await stalled.received('requested')
    await window.batch((batch) =>
      batch.set(label, {
        kind: 'text',
        text: 'Input and updates continue',
        style: { height: 32 },
      })
    )
    assert(transferPending, 'Tree update must complete before the clipboard deadline')
    record('commit-during-transfer', { treeRevision: 2, pending: transferPending })
    await rejection
    assert.equal(inputCount, 1)
    outcomes.stalledTransferDeadline = true
    outcomes.inputAndCommitDuringTransfer = true
    record('stalled-transfer-rejected', { elapsedMs: performance.now() - requestedAt })
  } finally {
    await stalled.stop()
  }

  for (const [name, mode, text] of [
    ['ordinary', 'text', `External ${nonce}: 世界🙂\r\n`],
    ['delayed', 'delayed', `Delayed ${nonce}`],
    ['incremental', 'incr', '🙂世界'.repeat(200)],
    ['empty-text', 'text', ''],
  ] as const) {
    const owner = await externalOwner(name, mode, text)
    try {
      const result = await window.readClipboardText()
      assert.deepEqual(result, { kind: 'text', text })
      assert(Object.isFrozen(result))
      await owner.received('served')
      if (mode === 'incr') assert(owner.records().filter((row) => row.type === 'chunk').length > 1)
      outcomes[name] = true
    } finally {
      await owner.stop()
    }
  }
  for (const [mode, code] of [
    ['oversize', 'payload_too_large'],
    ['incr-oversize', 'payload_too_large'],
    ['incr-header-large', 'payload_too_large'],
    ['invalid-utf8', 'native_failure'],
    ['nul', 'native_failure'],
    ['drop', 'native_failure'],
    ['slow-incr', 'operation_timed_out'],
    ['flood', 'limit_exceeded'],
  ] as const) {
    const owner = await externalOwner(mode, mode, `Bounded ${nonce}`)
    try {
      const requestedAt = performance.now()
      await assert.rejects(window.readClipboardText(), errorCode(code))
      if (mode === 'flood') await owner.received('flood-sent')
      record('negative-transfer', { mode, code, elapsedMs: performance.now() - requestedAt })
      outcomes[mode] = true
    } finally {
      await owner.stop()
    }
  }

  const cancelledOwner = await externalOwner('cancelled', 'delayed', `Cancelled ${nonce}`)
  try {
    const controller = new AbortController()
    const rejection = assert.rejects(
      window.readClipboardText({ signal: controller.signal }),
      errorCode('cancelled')
    )
    await cancelledOwner.received('requested')
    controller.abort()
    await rejection
    await cancelledOwner.received('served')
    outcomes.submittedReadCancellation = true
  } finally {
    await cancelledOwner.stop()
  }
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(window.readClipboardText({ signal: aborted.signal }), errorCode('cancelled'))
  outcomes.preDispatchCancellation = true

  const closeOwner = await externalOwner('closed-window', 'stall')
  try {
    const temporary = await app.openWindow({ title: 'Clipboard close control' })
    const rejection = assert.rejects(temporary.readClipboardText(), staleWindow)
    await closeOwner.received('requested')
    await temporary.close()
    await rejection
    await assert.rejects(temporary.readClipboardText(), staleWindow)
    assert(!existsSync(join(output, 'clipboard-closed-window.stop')))
    outcomes.pendingWindowClose = true
  } finally {
    await closeOwner.stop()
  }

  const copied = `Native write ${nonce}: 世界🙂`
  await window.writeClipboardText(copied)
  assert.deepEqual(await externalRead('read-written'), { kind: 'text', text: copied })
  outcomes.externalReadOfWrite = true
  const malformed = await peer('multiple-malformed', 'malformed-multiple')
  try {
    await malformed.received('multiple-rejected')
    outcomes.malformedMultipleRejected = true
  } finally {
    await malformed.stop()
  }
  record('write-idle')
  await step('after-write-idle')

  await window.writeClipboardText('')
  assert.deepEqual(await externalRead('read-empty'), { kind: 'text', text: '' })
  outcomes.externalEmptyText = true
  const writer = await app.openWindow({ title: 'Clipboard retained write control' })
  await writer.writeClipboardText(copied)
  await writer.close()
  assert.deepEqual(await externalRead('read-after-close'), { kind: 'text', text: copied })
  outcomes.writeSurvivesWindowClose = true

  const replacementText = `Replacement ${nonce}`
  const replacement = await externalOwner('replacement', 'text', replacementText)
  try {
    assert.deepEqual(await window.readClipboardText(), { kind: 'text', text: replacementText })
    record('lost-owner-idle')
    await step('after-lost-owner-idle')
    await window.batch((batch) =>
      batch.set(label, {
        kind: 'text',
        text: 'Clipboard checks passed',
        style: { height: 32 },
      })
    )
    record('completed', { treeRevision: 3, outcomes: { ...outcomes }, input: window.input(input) })
    await window.closed
    await assert.rejects(window.readClipboardText(), staleWindow)
    await stopped(app)
    assert.deepEqual(await externalRead('read-after-shutdown'), {
      kind: 'text',
      text: replacementText,
    })
    outcomes.shutdownPreservesNewExternalOwner = true
  } finally {
    await replacement.stop()
  }
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error))
} finally {
  if (app) {
    try {
      await stopped(app)
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error))
    }
  }
  for (const peer of peers) {
    try {
      await peer.stop()
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error))
    }
  }
  if (!Object.values(outcomes).every(Boolean))
    failure ??= new Error('Required clipboard outcome missing')
  writeFileSync(
    join(output, 'application-result.json'),
    JSON.stringify(
      {
        status: failure ? 'failed' : 'passed',
        scenario: 'clipboard',
        outcomes,
        inputCount,
        ownership: app?.diagnostics,
        peers: peerResults,
        error: failure?.message,
      },
      null,
      2
    ) + '\n'
  )
}
if (failure) throw failure

/** Real Bun PTY -> bounded callback source -> real MessageChannel stream consumer.
 * This is not CEF renderer integration, xterm rendering, or descendant supervision.
 */
import assert from 'node:assert/strict'
import { QualificationTerminal } from './terminal-consumer.ts'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CallbackStreamSource } from '../../packages/runtime/src/stream-source.ts'
import { BinaryStreamSender, BinaryStreamReceiver } from '../../packages/contracts/src/streams.ts'
import { StreamBudget } from '../../packages/contracts/src/stream-budget.ts'
import { rpcMessagePort } from '../../packages/client/src/index.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
type Mode = 'ordered' | 'cancelled' | 'overloaded'
async function scenario(mode: Mode) {
  const owner = {},
    sourceBudget = new StreamBudget(),
    sendBudget = new StreamBudget(),
    receiveBudget = new StreamBudget()
  const channel = new MessageChannel(),
    control = new MessageChannel()
  const firstConsumer = deferred<void>(),
    gate = deferred<void>(),
    failure = deferred<never>()
  const waiters = new Map<string, ReturnType<typeof deferred<Record<string, unknown>>>>()
  const terminalConsumer = new QualificationTerminal((record) =>
    waiters.get(String(record['type']))?.resolve(record)
  )
  const records = terminalConsumer.records
  let rawBytes = 0,
    consumedBytes = 0,
    stopCalls = 0,
    pendingStop = false,
    processExited = false
  const rawHash = createHash('sha256'),
    consumedHash = createHash('sha256')
  const consumers = new Set<Promise<void>>()
  const eof = deferred<number>()
  let child: ReturnType<typeof Bun.spawn> | undefined
  const awaitStep = <T>(promise: Promise<T>) => Promise.race([promise, failure.promise])
  function stopOwned() {
    stopCalls++
    if (child && !processExited) child.kill('SIGKILL')
    else if (!child) pendingStop = true
  }
  const timeout = setTimeout(() => {
    failure.reject(new Error('PTY qualification deadline'))
    stopOwned()
  }, 10_000)
  const receiver = new BinaryStreamReceiver(
    rpcMessagePort(channel.port1),
    { budget: receiveBudget, owner },
    {
      terminal: {
        consume(bytes) {
          const consuming = (async () => {
            firstConsumer.resolve()
            await gate.promise
            await terminalConsumer.consume(bytes)
            consumedHash.update(bytes)
            consumedBytes += bytes.length
          })()
          consumers.add(consuming)
          void consuming.finally(() => consumers.delete(consuming)).catch(() => {})
          return consuming
        },
      },
    }
  )
  const sender = new BinaryStreamSender(rpcMessagePort(channel.port2), {
    budget: sendBudget,
    owner,
  })
  let source: CallbackStreamSource | undefined
  let stage = 'stream-open'
  try {
    const writer = await awaitStep(sender.open('terminal'))
    const pump = new CallbackStreamSource(writer, {
      budget: sourceBudget,
      owner,
      stopSource: stopOwned,
      maxChunkBytes: 1024,
      maxRetainedBytes: mode === 'overloaded' ? 4096 : 128 * 1024,
      maxQueuedChunks: 256,
    })
    void pump.finished.then((result) => {
      if (!result.ok && mode === 'ordered')
        failure.reject(new Error('PTY source failed: ' + result.code))
    })
    source = pump
    const wait = (name: string) => {
      const existing = records.find((record) => record['type'] === name)
      if (existing) return Promise.resolve(existing)
      const waiter = deferred<Record<string, unknown>>()
      waiters.set(name, waiter)
      return awaitStep(waiter.promise)
    }
    stage = 'pty-spawn'
    child = Bun.spawn([process.execPath, fileURLToPath(new URL('./child.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        TERM: 'xterm-256color',
        ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
      },
      terminal: {
        cols: 100,
        rows: 30,
        data(_terminal, bytes) {
          rawBytes += bytes.byteLength
          rawHash.update(bytes)
          pump.push(bytes)
        },
        exit(_terminal, code) {
          eof.resolve(code)
          void pump.end()
        },
      },
    })
    const proc = child
    void proc.exited.then(() => {
      processExited = true
    })
    if (pendingStop) proc.kill('SIGKILL')
    const terminal = proc.terminal
    assert.ok(terminal)
    const write = (command: string) =>
      assert.equal(terminal.write(command + '\n'), Buffer.byteLength(command + '\n'))
    stage = 'first-output'
    await awaitStep(firstConsumer.promise)
    assert.equal(pump.diagnostics().acknowledgedBytes, 0)
    assert.equal(consumedBytes, 0)
    const controlReply = deferred<string>()
    control.port1.onmessage = (event) => control.port1.postMessage(event.data)
    control.port2.onmessage = (event) => controlReply.resolve(String(event.data))
    stage = 'control-while-paused'
    control.port2.postMessage('control-while-consumer-paused')
    assert.equal(await awaitStep(controlReply.promise), 'control-while-consumer-paused')
    if (mode !== 'ordered') {
      stage = 'controlled-source-stop'
      if (mode === 'cancelled') pump.cancel()
      else write('burst')
      const result = await awaitStep(pump.finished)
      assert.deepEqual(result, {
        ok: false,
        code: mode === 'cancelled' ? 'CANCELLED' : 'OVERLOADED',
      })
      assert.equal(stopCalls, 1)
      gate.resolve()
      const exitCode = await awaitStep(proc.exited)
      const terminalLifecycleCode = await awaitStep(eof.promise)
      assert.notEqual(exitCode, 0, 'Stopped fixture must not be relabeled a clean natural exit')
      await pump.drained
      assert.ok(pump.diagnostics().peakRetainedBytes <= (mode === 'overloaded' ? 4096 : 128 * 1024))
      return {
        name: mode,
        passed: true,
        controlledFailure: result,
        stopCalls,
        peakRetainedBytes: pump.diagnostics().peakRetainedBytes,
        childExitObserved: true,
        exitCode,
        signalCode: proc.signalCode,
        terminalLifecycleCode,
      }
    }
    gate.resolve()
    stage = 'ready-receipt'
    assert.equal((await wait('ready'))['tty'], true)
    stage = 'input-receipt'
    write('input')
    assert.equal((await wait('input'))['value'], 'owned-input')
    stage = 'resize-receipt'
    terminalConsumer.resize(110, 37)
    terminal.resize(110, 37)
    write('size')
    const size = await wait('size')
    assert.equal(size['cols'], 110)
    assert.equal(size['rows'], 37)
    stage = 'bulk-receipt'
    write('bulk')
    await wait('bulk-complete')
    const chunks = records.filter((record) => record['type'] === 'chunk')
    assert.equal(chunks.length, 64)
    chunks.forEach((record, index) =>
      assert.deepEqual(record, { type: 'chunk', index, value: 'caf\u00e9-\ud83d\udc19' })
    )
    stage = 'exit-and-eof'
    write('exit')
    assert.equal(await awaitStep(proc.exited), 0)
    const terminalLifecycleCode = await awaitStep(eof.promise)
    assert.ok(
      terminalLifecycleCode === 0 || (process.platform === 'linux' && terminalLifecycleCode === 1)
    )
    assert.deepEqual(await awaitStep(pump.finished), { ok: true })
    await pump.drained
    assert.equal((await wait('final'))['value'], 'last-output-before-exit')
    assert.equal(records.length, 69)
    assert.equal(terminalConsumer.unicodeObserved, true)
    assert.equal(rawBytes, consumedBytes)
    const digest = consumedHash.digest('hex')
    assert.equal(rawHash.digest('hex'), digest)
    assert.equal(stopCalls, 0)
    return {
      name: mode,
      passed: true,
      tty: true,
      input: true,
      resize: { cols: 110, rows: 37 },
      records: 64,
      receiptCount: records.length,
      callbackBytes: rawBytes,
      consumedBytes,
      sha256: digest,
      consumptionAcknowledged: true,
      consumer: 'xterm-headless-5.5.0-parser-callback',
      unicodeObserved: true,
      terminalLifecycleCode,
      cleanTerminalEof: terminalLifecycleCode === 0,
      terminalClosure:
        terminalLifecycleCode === 0 ? 'clean-eof' : 'read-error-status-with-complete-known-fixture',
      controlWhilePaused: true,
      terminalClosureAndChildExitObserved: true,
      peakRetainedBytes: pump.diagnostics().peakRetainedBytes,
    }
  } catch (error) {
    throw Object.assign(new Error('PTY qualification failed'), {
      diagnostic: {
        stage,
        failureType: error instanceof Error ? error.name : 'UnknownError',
        callbackBytes: rawBytes,
        consumedBytes,
        records: records.length,
        childExitObserved: processExited,
        source: source?.diagnostics() ?? null,
      },
    })
  } finally {
    clearTimeout(timeout)
    gate.resolve()
    if (child && !processExited) {
      child.kill('SIGKILL')
      await child.exited
    }
    child?.terminal?.close()
    source?.cancel()
    sender.close()
    receiver.close()
    control.port1.close()
    control.port2.close()
    // Closing rejects the sender immediately but does not reclaim a consumer
    // still parsing. Await its actual callback, not an arbitrary event-loop tick.
    await Promise.allSettled(consumers)
    await source?.drained
    await nextTurn()
    terminalConsumer.dispose()
    for (const budget of [sourceBudget, sendBudget, receiveBudget])
      assert.deepEqual(budget.diagnostics(), { reservedBytes: 0, streams: 0, views: 0 })
  }
}
export async function qualifyBunPty() {
  assert.equal(Bun.version, '1.4.3')
  assert.ok(['darwin', 'linux', 'win32'].includes(process.platform))
  assert.equal(Reflect.get(Bun.Terminal.prototype, 'pause'), undefined)
  assert.equal(Reflect.get(Bun.Terminal.prototype, 'resume'), undefined)
  const cases: Record<string, unknown>[] = []
  for (const mode of ['ordered', 'cancelled', 'overloaded'] as const) {
    try {
      cases.push({ ...(await scenario(mode)), reservationsReleased: true })
    } catch (error) {
      cases.push({
        name: mode,
        passed: false,
        failureType: error instanceof Error ? error.name : 'UnknownError',
        diagnostic: error instanceof Error ? (Reflect.get(error, 'diagnostic') ?? null) : null,
      })
      break
    }
  }
  return {
    schema: 1,
    classification: 'real-bun-pty-to-portable-stream-functional',
    passed: cases.length === 3 && cases.every((entry) => entry['passed'] === true),
    bun: Bun.version,
    target: `${process.platform}-${process.arch}`,
    cases,
    sourcePauseResume: { available: false, policy: 'bounded-callback-queue-or-explicit-stop' },
    limits: [
      'Real headless xterm parsing only; no CEF authority, graphical rendering or end-user latency qualification.',
      'Only the fixed directly owned child is stopped; detached descendants and generation replacement are not qualified.',
      'Checksums compare received PTY callback bytes with consumed stream bytes, not original child stdout bytes.',
      'Windows ConPTY may transform VT output; arbitrary binary/termios parity is not claimed.',
      'Linux may report PTY read-error status on last-slave hangup. Complete known fixture output is verified separately; this is not a general clean-EOF or arbitrary-shell success rule.',
    ],
  }
}

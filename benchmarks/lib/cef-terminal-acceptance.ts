import assert from 'node:assert/strict'
import { nativeEvents } from './cef-acceptance.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
import { validateCommandObservation, assertCleanCommand } from './observed-command.ts'

const object = (value: unknown, label: string): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label)
  return value as Record<string, unknown>
}
const integer = (value: unknown, label: string): number => {
  assert.ok(Number.isSafeInteger(value) && Number(value) >= 0, label)
  return Number(value)
}
const duration = (value: unknown, label: string): number => {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, label)
  return value
}
const checksum = (value: unknown, label: string): string => {
  assert.match(String(value), /^[a-f0-9]{64}$/, label)
  return String(value)
}
const trueValue = (value: unknown, label: string) => assert.equal(value, true, label)
const exact = (value: Record<string, unknown>, fields: readonly string[], label: string) =>
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), label)

export interface AcceptedGraphicalTerminal {
  readonly bytes: number
  readonly callbacks: number
  readonly controlRoundtripsMs: readonly number[]
  readonly consumerCallbackDurationsMs: readonly number[]
  readonly elapsedMs: number
  readonly workloadElapsedMs: number
  readonly peakTreeRssBytes: number
  readonly peakTreeThreads: number
  readonly queuePeakFrames: number
  readonly queuePeakBytes: number
}

/** Strictly accept raw native/browser observations. This never constructs a passing summary. */
export function acceptGraphicalTerminal(input: unknown): AcceptedGraphicalTerminal {
  const report = validateCommandObservation(input)
  assertCleanCommand(report)
  requireNativeShutdown(observeNativeShutdown(report))
  const events = nativeEvents(report)
  assert.deepEqual(
    events.filter((e) => e['event'] === 'bunly.host.shutdown'),
    [{ event: 'bunly.host.shutdown', clean: true }]
  )
  assert.equal(
    events.some((e) => e['event'] === 'bunly.host.failure' || e['event'] === 'bunly.host.error'),
    false
  )
  const exits = events.filter((e) => e['event'] === 'bunly.backend.exit')
  assert.equal(exits.length, 1)
  assert.equal(exits[0]!['code'], 0)
  assert.equal(exits[0]!['forced'], false)
  const drained = events.filter((e) => e['event'] === 'bunly.native.output-drained')
  assert.deepEqual(drained, [
    {
      event: 'bunly.native.output-drained',
      schema: 1,
      frames: 0,
      ordinaryFrames: 0,
      retainedWireBytes: 0,
      ordinaryWireBytes: 0,
    },
  ])
  assert.ok(events.indexOf(exits[0]!) < events.indexOf(drained[0]!))
  assert.ok(
    events.indexOf(drained[0]!) <
      events.findIndex(
        (e) =>
          e['event'] === 'bunly.host.shutdown-phase' &&
          e['phase'] === 'process-stop' &&
          e['state'] === 'complete'
      )
  )
  const receipts = events.filter((event) => event['event'] === 'bunly.native.graphical-terminal')
  assert.equal(receipts.length, 1, 'Graphical terminal receipt missing or duplicated')
  const receipt = receipts[0]!
  assert.ok(
    events.indexOf(receipt) <
      events.findIndex(
        (e) =>
          e['event'] === 'bunly.host.shutdown-phase' &&
          e['phase'] === 'process-stop' &&
          e['state'] === 'start'
      ),
    'Graphical workload receipt must precede shutdown'
  )
  exact(
    receipt,
    [
      'event',
      'schema',
      'classification',
      'renderer',
      'runtime',
      'gates',
      'budgets',
      'queuePeaks',
      'nativeFinal',
      'viewModes',
      'baseline',
    ],
    'Malformed graphical terminal receipt'
  )
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['classification'], 'functional')
  const renderer = object(receipt['renderer'], 'Missing renderer observations')
  exact(
    renderer,
    [
      'terminals',
      'controlRoundtripsMs',
      'heldConsumer',
      'rpcWhileHeld',
      'siblingWhileHeld',
      'parserCallbacks',
      'totalElapsedMs',
    ],
    'Malformed renderer observations'
  )
  trueValue(renderer['heldConsumer'], 'Consumer was not actually withheld')
  trueValue(renderer['rpcWhileHeld'], 'RPC did not progress while consumer was withheld')
  trueValue(renderer['siblingWhileHeld'], 'Sibling terminal did not progress')
  trueValue(renderer['parserCallbacks'], 'xterm callback consumption was not observed')
  const controls = renderer['controlRoundtripsMs']
  assert.ok(Array.isArray(controls) && controls.length >= 8, 'Missing control roundtrips')
  assert.ok(
    controls.every((value) => typeof value === 'number' && value >= 0 && Number.isFinite(value))
  )
  const terminals = renderer['terminals']
  assert.ok(
    Array.isArray(terminals) && terminals.length === 2,
    'Expected exactly two renderer terminals'
  )
  const runtime = object(receipt['runtime'], 'Missing runtime observations')
  const runtimeTerminals = runtime['terminals']
  assert.ok(Array.isArray(runtimeTerminals) && runtimeTerminals.length === 2)
  let bytes = 0
  let callbacks = 0
  const callbackDurations: number[] = []
  const identities = new Set<number>()
  for (const raw of terminals) {
    const terminal = object(raw, 'Malformed renderer terminal')
    const identity = integer(terminal['terminal'], 'Malformed terminal identity')
    assert.ok(identity < 2 && !identities.has(identity), 'Duplicate terminal receipt')
    identities.add(identity)
    const records = integer(terminal['records'], 'Missing record count')
    const order = terminal['order']
    assert.ok(Array.isArray(order) && order.length === records, 'Partial record order')
    assert.deepEqual(
      order,
      Array.from({ length: records }, (_, index) => index),
      'Record order mismatch'
    )
    assert.equal(records, identity === 0 ? 37 : 38, 'Unexpected exact terminal record count')
    const terminalBytes = integer(terminal['bytes'], 'Missing renderer bytes')
    const terminalCallbacks = integer(terminal['callbacks'], 'Missing renderer callbacks')
    assert.ok(terminalBytes > 0 && terminalCallbacks > 0)
    const durations = terminal['callbackDurationsMs']
    assert.ok(Array.isArray(durations) && durations.length === terminalCallbacks)
    assert.ok(
      durations.every((value) => typeof value === 'number' && value >= 0 && Number.isFinite(value))
    )
    const observed = object(runtimeTerminals[identity], 'Missing matching runtime terminal')
    exact(
      observed,
      [
        'processExit',
        'terminalClose',
        'terminalEof',
        'output',
        'released',
        'callbackBytes',
        'callbackCount',
        'callbackSha256',
        'streamWriteCount',
      ],
      'Malformed runtime terminal observation'
    )
    assert.equal(observed['callbackBytes'], terminalBytes, 'Runtime/consumer byte mismatch')
    assert.ok(integer(observed['callbackCount'], 'Missing runtime callbacks') > 0)
    assert.ok(Number(observed['callbackCount']) <= 4096)
    trueValue(terminal['unicodeObserved'], 'Actual terminal Unicode was not observed')
    assert.equal(
      observed['streamWriteCount'],
      terminalCallbacks,
      'Stream handoffs differ from actual consumer callbacks'
    )
    assert.equal(
      checksum(observed['callbackSha256'], 'Missing runtime checksum'),
      checksum(terminal['sha256'], 'Missing renderer checksum'),
      'Runtime/consumer checksum mismatch'
    )
    const exit = object(observed['processExit'], 'Missing process exit')
    trueValue(exit['started'], 'Process was not started')
    trueValue(exit['observed'], 'Process exit was not observed')
    assert.equal(exit['exitCode'], 0, 'Fixed child did not exit cleanly')
    assert.equal(exit['waitError'], false)
    assert.equal(exit['failure'], null)
    const closure = object(observed['terminalClose'], 'Missing PTY closure')
    trueValue(closure['observed'], 'PTY closure was not observed')
    assert.ok(closure['status'] === 0 || closure['status'] === 1, 'Unexpected PTY status')
    if (closure['status'] === 1)
      assert.equal(report.environment['os'], 'Linux', 'PTY status 1 is accepted only on Linux')
    assert.equal(
      observed['terminalEof'],
      closure['status'] === 0 ? 'clean-status-0' : 'linux-status-1-ambiguous',
      'PTY status ambiguity was hidden'
    )
    assert.deepEqual(observed['output'], { ok: true })
    trueValue(observed['released'], 'Terminal reservations did not release')
    bytes += terminalBytes
    callbacks += terminalCallbacks
    callbackDurations.push(...(durations as number[]))
  }
  assert.deepEqual(receipt['gates'], ['consumer-0:held', 'consumer-0:release'])

  const navigation = object(runtime['navigation'], 'Missing navigation abort observations')
  trueValue(navigation['exactOwner'], 'Navigation did not target an exact distinct owner')
  trueValue(navigation['released'], 'Navigation-owned terminal did not release')
  trueValue(navigation['siblingCompleted'], 'Navigation harmed sibling terminal')
  assert.deepEqual(navigation['output'], { ok: false, code: 'CANCELLED' })
  const navigationExit = object(navigation['processExit'], 'Missing navigation process exit')
  trueValue(navigationExit['observed'], 'Navigation process exit was not observed')
  assert.notEqual(navigationExit['exitCode'], 0, 'Aborted navigation child reported clean exit')

  const overload = object(runtime['overload'], 'Missing overload observations')
  trueValue(overload['released'], 'Overloaded terminal did not release')
  assert.deepEqual(overload['output'], { ok: false, code: 'OVERLOADED' })
  assert.ok(integer(overload['callbackBytes'], 'Missing overload byte count') > 0)
  assert.ok(integer(overload['callbackBytes'], 'Unbounded overload bytes') <= 2 * 1024 * 1024)
  assert.ok(integer(overload['callbackCount'], 'Missing overload callbacks') > 0)
  const overloadExit = object(overload['processExit'], 'Missing overload process exit')
  trueValue(overloadExit['observed'], 'Overload process exit was not observed')
  assert.notEqual(overloadExit['exitCode'], 0, 'Overloaded child reported clean exit')

  const budgets = object(receipt['budgets'], 'Missing final budgets')
  const terminalBudget = object(budgets['terminal'], 'Missing terminal budget')
  for (const name of [
    'terminals',
    'reservedOutputBytes',
    'owners',
    'sourceReservedBytes',
    'sourceStreams',
    'spawning',
    'live',
    'closing',
    'pendingDriverWrites',
    'driverFailures',
  ])
    assert.equal(terminalBudget[name], 0, `Nonzero final terminal budget: ${name}`)
  const streamBudget = object(budgets['stream'], 'Missing stream budget')
  assert.equal(streamBudget['connections'], 0)
  assert.deepEqual(streamBudget['budget'], { reservedBytes: 0, streams: 0, views: 0 })
  const nativeFinal = object(receipt['nativeFinal'], 'Missing native final state')
  assert.equal(nativeFinal['windows'], 1)
  assert.equal(nativeFinal['views'], 0)
  assert.equal(nativeFinal['sessions'], 0)
  assert.equal(nativeFinal['streamIncomingBytes'], 0)
  const queuePeaks = object(receipt['queuePeaks'], 'Missing observed queue peaks')
  assert.ok(integer(queuePeaks['frames'], 'Missing queue frame peak') > 0)
  assert.ok(integer(queuePeaks['frames'], 'Unbounded queue frame peak') <= 128)
  assert.ok(integer(queuePeaks['bytes'], 'Missing queue byte peak') > 0)
  assert.ok(integer(queuePeaks['bytes'], 'Unbounded queue byte peak') <= 2 * 1024 * 1024)
  assert.deepEqual(receipt['viewModes'], {
    foreground: 'visible-window-exercised',
    background: 'NOT_QUALIFIED-no-maintained-native-visibility-control',
    minimized: 'NOT_QUALIFIED-no-maintained-native-minimize-control',
  })
  assert.equal(receipt['baseline'], 'NOT_CLAIMED-no-identical-baseline-workload')
  return Object.freeze({
    bytes,
    callbacks,
    controlRoundtripsMs: Object.freeze([...(controls as number[])]),
    consumerCallbackDurationsMs: Object.freeze(callbackDurations),
    elapsedMs: report.elapsedMs,
    workloadElapsedMs: duration(renderer['totalElapsedMs'], 'Missing workload elapsed time'),
    peakTreeRssBytes: report.peakTreeRssBytes,
    peakTreeThreads: report.peakTreeThreads,
    queuePeakFrames: integer(queuePeaks['frames'], 'Missing queue frame peak'),
    queuePeakBytes: integer(queuePeaks['bytes'], 'Missing queue byte peak'),
  })
}

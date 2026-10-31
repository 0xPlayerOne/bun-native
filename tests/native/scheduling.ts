import { NativeHost, type WindowCommand } from '@bun-native/runtime'
import type { Operation } from '@bun-native/protocol'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Actual UI scheduling regression. The controller injects one XTest edit while
// bounded legal commands remain in flight. This is not a throughput benchmark.
const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const executable = process.env['BUN_NATIVE_HOST']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
const scenario = process.env['BUN_NATIVE_DIAGNOSTICS_SCENARIO']
if (
  !directory ||
  !executable ||
  !nonce ||
  !['scheduling', 'scheduling-control'].includes(scenario ?? '')
)
  throw new Error('Explicit native diagnostics directory, host, nonce and scenario are required')
const queued = scenario === 'scheduling'
const started = performance.now()
const record = (type: string, fields: Record<string, unknown> = {}) => {
  appendFileSync(
    join(directory, 'application.jsonl'),
    JSON.stringify({ nonce, type, atMs: performance.now() - started, ...fields }) + '\n'
  )
}
const host = await NativeHost.launch({ executable, requestTimeoutMs: 10_000 })
let producing = false
let inputDuringProducer = false
let revision = 0
const inputEvents: Array<{ atMs: number; producerActive: boolean; value: string }> = []
const incoming = (async () => {
  for await (const event of host) {
    if (event.type === 'input') {
      assert.equal(event.window_id, 1)
      assert.equal(event.node_id, 6)
      assert.equal(inputEvents.length, 0, 'The fixed workload accepts exactly one edit')
      assert.equal(event.input_revision, 1)
      assert.equal(event.value, 'x')
      inputDuringProducer ||= producing
      inputEvents.push({
        atMs: performance.now() - started,
        producerActive: producing,
        value: event.value,
      })
    }
    record(event.type, { ...event, producerActive: producing })
  }
})()
// Keep a failed background event assertion observable while cleanup still runs.
void incoming.catch(() => {})
let sent = 0
let acknowledged = 0
let outstanding = 0
let maximumOutstanding = 0
const durationsMs: number[] = []
try {
  await host.send({
    type: 'open',
    window_id: 1,
    root_id: 1,
    title: 'Bun Native scheduling audit',
    width: 560,
    height: 380,
  })
  const elements = [
    { kind: 'text', text: 'Scheduling audit', style: { font_size: 28 } },
    { kind: 'text', text: 'Ready' },
    { kind: 'button', text: 'Increment', style: { width: 160, height: 44 } },
    { kind: 'text', text: 'Native editable input' },
    {
      kind: 'input',
      value: '',
      placeholder: 'Type here…',
      style: { width: 'fill', font_size: 24 },
    },
    { kind: 'box', style: { width: 1, height: 1, gap: 0 } },
  ] as const
  const operations: Operation[] = [
    {
      type: 'set',
      node_id: 1,
      element: {
        kind: 'box',
        style: { direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 },
      },
    },
  ]
  elements.forEach((element, index) =>
    operations.push(
      { type: 'create', node_id: index + 2, element },
      { type: 'insert', parent_id: 1, child_id: index + 2, index }
    )
  )
  await host.send({ type: 'batch', window_id: 1, base_revision: revision++, operations })
  const fillerCount = 1024
  for (let start = 0; start < fillerCount; start += 128) {
    const chunk: Operation[] = []
    for (let index = start; index < Math.min(start + 128, fillerCount); index++)
      chunk.push(
        {
          type: 'create',
          node_id: index + 8,
          element: { kind: 'text', text: '', style: { height: 1, width: 1 } },
        },
        { type: 'insert', parent_id: 7, child_id: index + 8, index }
      )
    await host.send({ type: 'batch', window_id: 1, base_revision: revision++, operations: chunk })
  }
  record('mounted', { treeRevision: revision, fillerCount, nodeCount: fillerCount + 7 })
  const startDeadline = performance.now() + 10_000
  while (!existsSync(join(directory, 'start'))) {
    if (performance.now() >= startDeadline)
      throw new Error('Controller did not start the bounded stream')
    await Bun.sleep(5)
  }
  const streamStarted = performance.now()
  producing = true
  record('stream-start', { pendingLimit: queued ? 128 : 1, producerDurationMs: 3000 })
  function stopProducer(): void {
    if (!producing) return
    producing = false
    record('producer-stopped', { sent, acknowledged, outstanding })
  }
  function command(): Extract<WindowCommand, { type: 'batch' }> {
    return {
      type: 'batch',
      window_id: 1,
      base_revision: revision++,
      operations: [{ type: 'set', node_id: 3, element: { kind: 'text', text: `Update ${sent}` } }],
    }
  }
  if (queued) {
    const drained = Promise.withResolvers<void>()
    const send = () => {
      if (performance.now() - streamStarted >= 3000) {
        stopProducer()
        if (!outstanding) drained.resolve()
        return
      }
      const requestStarted = performance.now()
      sent += 1
      outstanding += 1
      maximumOutstanding = Math.max(maximumOutstanding, outstanding)
      void host.send(command()).then(
        () => {
          acknowledged += 1
          outstanding -= 1
          durationsMs.push(performance.now() - requestStarted)
          if (acknowledged % 100 === 0) record('progress', { sent, acknowledged, outstanding })
          if (producing) send()
          if (!producing && !outstanding) drained.resolve()
        },
        (error: unknown) => {
          stopProducer()
          drained.reject(error)
        }
      )
    }
    for (let index = 0; index < 128; index++) send()
    await drained.promise
  } else {
    while (performance.now() - streamStarted < 3000) {
      const requestStarted = performance.now()
      sent += 1
      outstanding = 1
      maximumOutstanding = 1
      await host.send(command())
      acknowledged += 1
      outstanding = 0
      durationsMs.push(performance.now() - requestStarted)
      await Bun.sleep(1)
    }
    stopProducer()
  }
  record('stream-drained', {
    sent,
    acknowledged,
    outstanding,
    maximumOutstanding,
    elapsedMs: performance.now() - streamStarted,
  })
  // Permit a delayed event to be reported before failing the fairness assertion;
  // the historical defect delivers it only after all queued work drains.
  await Bun.sleep(300)
  assert.equal(sent, acknowledged)
  assert.equal(inputEvents.length, 1, 'Exactly one real input edit must reach Bun')
  assert.equal(
    inputDuringProducer,
    true,
    'Native input was starved until the command producer stopped'
  )
  await host.send({
    type: 'batch',
    window_id: 1,
    base_revision: revision++,
    operations: [
      { type: 'delete', node_id: 7 },
      { type: 'set', node_id: 3, element: { kind: 'text', text: 'Stream completed' } },
      { type: 'insert', parent_id: 1, child_id: 3, index: 0 },
    ],
  })
  record('completed', { treeRevision: revision })
  const closeDeadline = performance.now() + 10_000
  while (!existsSync(join(directory, 'close'))) {
    if (performance.now() >= closeDeadline)
      throw new Error('Controller did not observe final paint')
    await Bun.sleep(5)
  }
  await host.send({ type: 'close', window_id: 1 })
  writeFileSync(
    join(directory, 'application-result.json'),
    JSON.stringify(
      {
        status: 'passed',
        scenario,
        sent,
        acknowledged,
        maximumOutstanding,
        requestAcknowledgementMs: durationsMs,
        inputEvents,
        scope:
          'Bounded scheduling regression with explicit native-paint instrumentation; acknowledgements are not display presentation or per-keystroke latency.',
      },
      null,
      2
    ) + '\n'
  )
} finally {
  producing = false
  await host.shutdown()
  await incoming
}
record('finished', { exitCode: await host.exited })

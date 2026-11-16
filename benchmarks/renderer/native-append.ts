/** Paired native-host append probe; paint observation includes evidence I/O. */
import { createApplication } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  insertNode,
  removeNode,
  setProperty,
} from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const [host, output, evidence, nonce] = process.argv.slice(2)
if (!host || !output || !evidence || !nonce || ![host, output, evidence].every(isAbsolute))
  throw new Error('Expected absolute host, output and evidence paths and a nonce')
const evidencePath = evidence
if (existsSync(evidence)) throw new Error('Evidence path must be new')
process.env['BUN_NATIVE_EVIDENCE_LOG'] = evidence
process.env['BUN_NATIVE_EVIDENCE_NONCE'] = nonce
const rows = 384
const samples = 8
const result: Record<string, unknown> = {
  status: 'running',
  rows,
  samples,
  bunRevision: Bun.revision,
  scope:
    'renderer append through native acknowledgement and observed GPUI paint record; not display presentation',
}
let application: Awaited<ReturnType<typeof createApplication>> | undefined
let failure: unknown
try {
  application = await createApplication({ executable: host, requestTimeoutMs: 10_000 })
  const window = await application.openWindow({
    title: 'Bun Native append probe',
    width: 640,
    height: 720,
  })
  let list!: ReturnType<typeof createElement>
  const root = createRenderRoot(window, ({ container }) => {
    list = createElement('box')
    insertNode(container, list)
    for (let i = 0; i < rows; i++) {
      const child = createElement('text')
      setProperty(child, 'text', `row ${i}`)
      insertNode(list, child)
    }
  })
  await root.ready
  const initialRevision = window.revision
  type PaintedNode = { node_id: number; element: Record<string, unknown>; children: number[] }
  async function paint(revision: number): Promise<PaintedNode[]> {
    const deadline = performance.now() + 15_000
    while (performance.now() < deadline) {
      if (existsSync(evidencePath)) {
        if (statSync(evidencePath).size > 4_194_304) throw new Error('Paint evidence exceeds 4 MiB')
        const lines = readFileSync(evidencePath, 'utf8').split('\n').slice(0, -1)
        for (const line of lines) {
          const event = JSON.parse(line) as Record<string, unknown>
          assert.equal(event['nonce'], nonce)
          if (event['type'] === 'rendered' && event['tree_revision'] === revision) {
            assert.equal(event['stage'], 'native-paint')
            assert(
              Array.isArray(event['nodes']),
              'Full paint tree required; omitted records cannot pass'
            )
            return event['nodes'] as PaintedNode[]
          }
        }
      }
      await Bun.sleep(1)
    }
    throw new Error(`Native paint revision ${revision} not observed`)
  }
  const original = await paint(initialRevision)
  const records = readFileSync(evidencePath, 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const renderer = records.find((record) => record['type'] === 'renderer')
  assert(renderer, 'Native renderer identity is required')
  result['renderer'] = renderer
  result['initialTree'] = original
  assert.equal(original.length, rows + 3)
  const listRecord = original.find((node) => node.children.length === rows)
  assert(listRecord, 'Expected one wide list')
  const byId = new Map(original.map((node) => [node.node_id, node]))
  assert.equal(byId.size, original.length)
  for (let i = 0; i < rows; i++)
    assert.deepEqual(byId.get(listRecord.children[i]!)?.element, {
      kind: 'text',
      text: `row ${i}`,
      style: {},
    })
  const timings: { ackMs: number; paintObservedMs: number }[] = []
  for (let i = 0; i < samples + 2; i++) {
    const child = createElement('text')
    setProperty(child, 'text', `append ${i}`)
    insertNode(list, child)
    const previousRevision = window.revision
    const start = performance.now()
    await root.flush()
    const ackMs = performance.now() - start
    assert.equal(window.revision, previousRevision + 1)
    const painted = await paint(window.revision)
    const paintObservedMs = performance.now() - start
    assert.equal(painted.length, original.length + 1)
    const changedList: PaintedNode | undefined = painted.find(
      (node) => node.node_id === listRecord.node_id
    )
    assert(changedList)
    assert.deepEqual(changedList.element, listRecord.element)
    assert.deepEqual(changedList.children.slice(0, -1), listRecord.children)
    const newId = changedList.children.at(-1)
    assert(newId !== undefined && !byId.has(newId))
    assert.deepEqual(painted.find((node) => node.node_id === newId)?.element, {
      kind: 'text',
      text: `append ${i}`,
      style: {},
    })
    assert.deepEqual(
      painted.filter((node) => node.node_id !== newId && node.node_id !== listRecord.node_id),
      original.filter((node) => node.node_id !== listRecord.node_id)
    )
    if (i >= 2) timings.push({ ackMs, paintObservedMs })
    removeNode(list, child)
    const appendedRevision = window.revision
    await root.flush()
    assert.equal(window.revision, appendedRevision + 1)
    assert.deepEqual(await paint(window.revision), original)
  }
  result['timings'] = timings
  await root.dispose()
  await window.close()
  result['status'] = 'passed'
} catch (error) {
  failure = error
  result['status'] = 'failed'
  result['error'] = String(error)
} finally {
  if (application) {
    try {
      await application.shutdown()
      await application.closed
      result['cleanup'] = application.diagnostics
      assert.deepEqual(application.diagnostics, {
        windows: 0,
        nodes: 0,
        callbacks: 0,
        queuedTransactions: 0,
        queuedCallbacks: 0,
        activeCallbacks: 0,
        serviceRequests: 0,
      })
    } catch (error) {
      failure ??= error
      result['status'] = 'failed'
      result['cleanupError'] = String(error)
    }
  }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
}
if (failure) throw failure

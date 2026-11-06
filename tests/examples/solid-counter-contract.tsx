import { createApplication } from '@bun-native/core'
import { render } from '@bun-native/solid'
import assert from 'node:assert/strict'
import { App, createCounterStats } from '../../examples/solid-counter/app.tsx'
import { mirrorWindow, withEvidence } from './support.ts'

// Real public adapter/IPC with synthetic peer events, compiled by the Solid
// build path. No rendering, OS-input, geometry or pixel acceptance claim.
const peer = process.env['BUN_NATIVE_EXAMPLE_TEST_PEER']
if (!peer) throw new Error('The contract test must provide its owned protocol peer')

async function until(condition: () => boolean) {
  const deadline = performance.now() + 3_000
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('The Solid counter contract did not settle')
    await Bun.sleep(1)
  }
}

const report: Record<string, unknown> = {}
await withEvidence(async (evidence) => {
  const app = await createApplication({ executable: process.execPath, args: [peer] })
  const actual = await app.openWindow({ title: 'Solid counter example contract' })
  const marker = await actual.batch((batch) => {
    const node = batch.create({ kind: 'text', text: 'Contract marker' })
    batch.append(actual.root, node)
    return node
  })
  const dispatch = (type: 'click' | 'input', target: string) =>
    actual.batch((batch) =>
      batch.set(marker, { kind: 'text', text: `event:${JSON.stringify({ type, target })}` })
    )
  const settled = () =>
    app.diagnostics.activeCallbacks === 0 && app.diagnostics.queuedCallbacks === 0
  const { window, tree } = mirrorWindow(actual)
  const stats = createCounterStats()
  const view = render(() => <App stats={stats} view={() => view} />, window)
  try {
    await view.ready
    await view.flush()
    report['initial'] = tree()
    report['mounted'] = { ...stats }

    await dispatch('click', 'Increment')
    await until(() => evidence().some((entry) => entry.type === 'solid-keyed-update'))
    await until(settled)
    await view.flush()
    report['clicked'] = tree()
    report['afterClick'] = { ...stats }

    await dispatch('click', 'Increment')
    await until(() => evidence().filter((entry) => entry.type === 'click').length === 2)
    await until(settled)
    await view.flush()
    report['clickedTwice'] = tree()

    await dispatch('input', 'Type here…')
    await until(() => tree().some((line) => line.endsWith('text:Input: native edit')))
    await until(settled)
    await view.flush()
    report['input'] = tree()
    report['evidence'] = evidence().map((entry) => entry.type)

    await actual.close()
    await view.closed
    report['closed'] = {
      nodes: view.diagnostics.nodes,
      listeners: view.diagnostics.listeners,
      stats: { ...stats },
    }
  } finally {
    try {
      await view.dispose()
    } finally {
      await app.shutdown()
      await app.closed
    }
  }
  assert(Object.values(app.diagnostics).every((value) => value === 0))
  report['application'] = app.diagnostics
})
console.log(JSON.stringify(report))

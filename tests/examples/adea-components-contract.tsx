import { createApplication } from '@bun-native/core'
import { render } from '@bun-native/solid'
import assert from 'node:assert/strict'
import { App, createAppStats } from '../../examples/adea-components/app.tsx'
import { mirrorWindow, withEvidence } from './support.ts'

// Real public adapter/IPC with synthetic routed peer events, compiled by the
// Solid build path. No rendering, OS-input, focus, geometry or pixel claim.
const peer = process.env['BUN_NATIVE_EXAMPLE_TEST_PEER']
if (!peer) throw new Error('The contract test must provide its owned protocol peer')

async function until(condition: () => boolean, what: string) {
  const deadline = performance.now() + 3_000
  while (!condition()) {
    if (performance.now() >= deadline)
      throw new Error(`The Adea component contract did not ${what}`)
    await Bun.sleep(1)
  }
}

type Spec = { type: string; target: string; key?: string }
const report: Record<string, unknown> = {}
await withEvidence(async (evidence) => {
  const app = await createApplication({
    executable: process.execPath,
    args: [peer, '--overlays', '--keyboard', '--split-resize', '--decoration'],
  })
  const actual = await app.openWindow({ title: 'Adea components contract' })
  const marker = await actual.batch((batch) => {
    const node = batch.create({ kind: 'text', text: 'Contract marker' })
    batch.append(actual.root, node)
    return node
  })
  const settled = () =>
    app.diagnostics.activeCallbacks === 0 && app.diagnostics.queuedCallbacks === 0
  const { window, tree } = mirrorWindow(actual)
  const stats = createAppStats()
  const view = render(() => <App stats={stats} tickMs={2} />, window)
  const step = async (spec: Spec) => {
    await actual.batch((batch) =>
      batch.set(marker, { kind: 'text', text: `event:${JSON.stringify([spec])}` })
    )
    await Bun.sleep(5)
    await until(settled, `settle after ${spec.type} ${spec.target}`)
    await view.flush()
  }
  const has = (line: string) => tree().some((entry) => entry.trim() === line)
  try {
    await view.ready
    await view.flush()
    report['initial'] = tree()
    report['mounted'] = { ...stats }

    await step({ type: 'input', target: 'Message Octy' })
    await step({ type: 'click', target: 'Send' })
    await until(() => evidence().some((entry) => entry.type === 'reply-complete'), 'stream')
    await until(settled, 'settle after streaming')
    await view.flush()
    report['streamed'] = { stats: { ...stats }, tree: tree() }

    await step({ type: 'click', target: 'Dark theme' })
    report['themed'] = { stats: { ...stats }, lightButton: has('button:Light theme') }

    await step({ type: 'click', target: 'Conversation' })
    report['menuOpen'] = {
      overlay: has('overlay'),
      items: tree()
        .filter((l) => /button:(Rename|Export|Delete)$/.test(l.trim()))
        .map((l) => l.trim()),
    }
    await step({ type: 'key_down', target: 'overlay#0', key: 'escape' })
    report['menuEscaped'] = has('overlay')
    await step({ type: 'click', target: 'Conversation' })
    await step({ type: 'click', target: 'Export' })
    report['menuExport'] = { overlay: has('overlay'), status: has('text:Export') }

    await step({ type: 'click', target: 'Conversation' })
    await step({ type: 'click', target: 'Delete' })
    report['dialogOpen'] = { overlay: has('overlay'), title: has('text:Delete conversation?') }
    await step({ type: 'pointer_down', target: 'overlay#0' })
    report['backdropDismissed'] = has('overlay')
    await step({ type: 'click', target: 'Conversation' })
    await step({ type: 'click', target: 'Delete' })
    await step({ type: 'click', target: 'Close' })
    report['closeDismissed'] = has('overlay')
    await step({ type: 'click', target: 'Conversation' })
    await step({ type: 'click', target: 'Delete' })
    await step({ type: 'click', target: 'Delete' })
    report['deleted'] = {
      stats: { ...stats },
      overlay: has('overlay'),
      status: has('text:Deleted'),
    }
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
})
console.log(JSON.stringify(report))

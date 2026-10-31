import { createApplication, type Style } from '@bun-native/core'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// A public-core consumer. Only the external controller delivers pointer, wheel,
// keyboard and resize operations; private files sequence bounded test updates.
const directory = process.env['BUN_NATIVE_DIAGNOSTICS_DIR']
const executable = process.env['BUN_NATIVE_HOST']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (!directory || !isAbsolute(directory) || !executable || !nonce)
  throw new Error('Explicit native diagnostics directory, host and nonce are required')
const outputDirectory = directory
const record = (type: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(
    join(directory, 'application.jsonl'),
    JSON.stringify({ nonce, type, ...fields }) + '\n'
  )
async function step(name: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!existsSync(join(outputDirectory, name))) {
    if (performance.now() >= deadline) throw new Error('Controller did not request ' + name)
    await Bun.sleep(5)
  }
}

const scrollStyle = {
  direction: 'column',
  width: 'fill',
  height: 140,
  overflow: 'scroll_y',
  background: 0xe2e8f0,
} as const satisfies Style
const inputStyle = { width: 'fill', height: 40, font_size: 20 } as const
const app = await createApplication({ executable })
assert(app.capabilities.includes('layout_v1'))
const clicks = { top: 0, bottom: 0 }
const inputEvents: Array<{ value: string; revision: number; sequence: number }> = []
const signals: AbortSignal[] = []
let lastSequence = 0
try {
  const window = await app.openWindow({ title: 'Bun Native layout', width: 640, height: 480 })
  const nodes = await window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: { direction: 'column', padding: 16, gap: 12, background: 0xf4f5f7 },
    })
    const heading = batch.create({
      kind: 'text',
      text: 'Shared native layout',
      style: { height: 32, font_size: 24 },
    })
    const row = batch.create({
      kind: 'box',
      style: {
        direction: 'row',
        width: 'fill',
        height: 64,
        gap: 12,
        align_items: 'center',
        justify_content: 'space_between',
      },
    })
    const minimum = batch.create({
      kind: 'text',
      text: 'Min 80',
      style: { width: 20, min_width: 80, max_width: 100, height: 24, background: 0xf9c8c8 },
    })
    const bounded = batch.create({
      kind: 'text',
      text: 'Bounded',
      style: {
        width: 'fill',
        min_width: 120,
        max_width: 200,
        height: 24,
        flex_shrink: 1,
        background: 0xc8dcf9,
      },
    })
    const disabled = batch.create({
      kind: 'button',
      text: 'Disabled',
      disabled: true,
      style: { width: 100, height: 36 },
    })
    const scroll = batch.create({ kind: 'box', style: scrollStyle })
    const top = batch.create({
      kind: 'button',
      text: 'Top action',
      style: { width: 'fill', height: 44 },
    })
    const spacer = batch.create({
      kind: 'box',
      style: { width: 'fill', height: 180, background: 0xd9e1e8 },
    })
    const bottom = batch.create({
      kind: 'button',
      text: 'Bottom action',
      style: { width: 'fill', height: 44, background: 0x177344 },
    })
    const tail = batch.create({ kind: 'text', text: 'Scroll end', style: { height: 40 } })
    const input = batch.create({ kind: 'input', value: 'ABC', style: inputStyle })
    for (const child of [heading, row, scroll, input]) batch.append(window.root, child)
    for (const child of [minimum, bounded, disabled]) batch.append(row, child)
    for (const child of [top, spacer, bottom, tail]) batch.append(scroll, child)
    return { scroll, top, spacer, bottom, tail, input }
  })
  for (const [target, node] of [
    ['top', nodes.top],
    ['bottom', nodes.bottom],
  ] as const)
    window.onClick(node, (event) => {
      assert.equal(event.sequence, ++lastSequence)
      assert.equal(event.signal.aborted, false)
      signals.push(event.signal)
      clicks[target] += 1
      record('click', { target, sequence: event.sequence })
    })
  window.onInput(nodes.input, (event) => {
    assert.equal(event.sequence, ++lastSequence)
    const entry = { value: event.value, revision: event.revision, sequence: event.sequence }
    inputEvents.push(entry)
    record('input', entry)
  })
  record('mounted', { treeRevision: window.revision, input: window.input(nodes.input) })
  await step('restyle')
  const before = window.input(nodes.input)
  await window.batch((batch) => {
    batch.set(nodes.scroll, {
      kind: 'box',
      style: {
        ...scrollStyle,
        min_height: 140,
        max_height: 140,
        flex_shrink: 1,
        background: 0xe4eedf,
      },
    })
    batch.insert(window.root, nodes.scroll, 3)
  })
  assert.deepEqual(window.input(nodes.input), before)
  record('restyled', { treeRevision: window.revision, input: window.input(nodes.input) })

  await step('input-style')
  assert.deepEqual(window.input(nodes.input), { value: 'ABxC', revision: 1 })
  await window.batch((batch) =>
    batch.set(
      nodes.input,
      {
        kind: 'input',
        value: 'ABxC',
        style: { ...inputStyle, font_size: 24, min_width: 120 },
      },
      1
    )
  )
  assert.deepEqual(window.input(nodes.input), { value: 'ABxC', revision: 2 })
  record('input-styled', { treeRevision: window.revision, input: window.input(nodes.input) })

  await step('horizontal')
  await window.batch((batch) =>
    batch.set(nodes.scroll, {
      kind: 'box',
      style: { ...scrollStyle, direction: 'row', overflow: 'scroll_x' },
    })
  )
  record('horizontal', { treeRevision: window.revision })

  await step('disable-scroll')
  await window.batch((batch) =>
    batch.set(nodes.scroll, {
      kind: 'box',
      style: { ...scrollStyle, direction: 'row', overflow: 'hidden' },
    })
  )
  record('scroll-disabled', { treeRevision: window.revision })

  await step('restore-scroll')
  await window.batch((batch) => batch.set(nodes.scroll, { kind: 'box', style: scrollStyle }))
  record('scroll-restored', { treeRevision: window.revision })

  await step('shrink')
  assert.deepEqual(window.input(nodes.input), { value: 'ABxYC', revision: 3 })
  await window.batch((batch) => {
    batch.remove(nodes.spacer)
    batch.remove(nodes.tail)
    batch.insert(nodes.scroll, nodes.bottom, 0)
  })
  record('shrunk', { treeRevision: window.revision })

  await step('disable')
  assert.deepEqual(clicks, { top: 2, bottom: 3 })
  await window.batch((batch) =>
    batch.set(nodes.bottom, {
      kind: 'button',
      text: 'Bottom action',
      disabled: true,
      style: { width: 'fill', height: 44 },
    })
  )
  record('disabled', { treeRevision: window.revision })

  await step('dispose')
  await window.batch((batch) => batch.remove(nodes.scroll))
  assert(signals.every((signal) => signal.aborted))
  assert.equal(app.diagnostics.callbacks, 1)
  assert.deepEqual(window.input(nodes.input), { value: 'ABxYC', revision: 3 })
  record('disposed', { treeRevision: window.revision, ownership: app.diagnostics })
  await window.closed
} finally {
  await app.shutdown()
  await app.closed
}
assert.deepEqual(inputEvents, [
  { value: 'ABxC', revision: 1, sequence: 3 },
  { value: 'ABxYC', revision: 3, sequence: 4 },
])
assert.equal(lastSequence, 7)
assert(Object.values(app.diagnostics).every((count) => count === 0))
writeFileSync(
  join(directory, 'application-result.json'),
  JSON.stringify({
    status: 'passed',
    scenario: 'layout',
    clicks,
    inputEvents,
    ownership: app.diagnostics,
  }) + '\n'
)

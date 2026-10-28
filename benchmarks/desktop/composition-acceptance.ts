import assert from 'node:assert/strict'
import { parseViewPresentationState, type Bounds } from '../../packages/contracts/src/index.ts'
import {
  compositionMarker,
  panes,
  parseCompositionPage,
  type CompositionPage,
  type Pane,
} from '../../examples/view-composition/contract.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const COMPOSITION_PROFILE = 'native-view-composition-v1'
// Do not broaden the historical window-v1 selectors: old reports must replay
// against exactly the source inventory that their original runner selected.
export const compositionSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/view-composition',
  'examples/managed-desktop/document-readiness.ts',
] as const
const requiredSources = [
  'packages/contracts/src/view-composition.ts',
  'native/cef-host/src/view_composition.rs',
  'examples/view-composition/fixture.ts',
  'examples/view-composition/client.ts',
  'examples/view-composition/contract.ts',
  'examples/managed-desktop/document-readiness.ts',
  'benchmarks/desktop/composition-acceptance.ts',
] as const
export const compositionSteps = [
  ['initial-left', 'left'],
  ['initial-right', 'right'],
  ['initial-overlay', 'overlay'],
  ['overlay-hidden', 'overlay'],
  ['focus-left', 'left'],
  ['forward-tab-order', 'right'],
  ['reverse-tab-order', 'left'],
  ['hidden-pane', 'left'],
  ['focus-right', 'right'],
  ['restored-pane', 'left'],
  ['nonfocusable-pane', 'right'],
  ['focus-left', 'left'],
  ['clipped-viewport', 'left'],
  ['fully-clipped-pane', 'left'],
  ['clip-cleared', 'left'],
  ['window-clips-pane', 'right'],
  ['window-restores-pane', 'right'],
  ['focus-right', 'right'],
  ['rapid-resize-final', 'left'],
  ['resize-preserves-sibling-focus', 'right'],
  ['retained-after-generations', 'left'],
  ['overlay-shown', 'overlay'],
  ['focus-overlay', 'overlay'],
  ['overlay-before-close', 'overlay'],
  ['focus-right', 'right'],
  ['sibling-after-overlay-close', 'right'],
  ['final-left', 'left'],
  ['final-right', 'right'],
] as const
const rectangles: Readonly<Record<Pane, Bounds>> = {
  left: { x: 24, y: 24, width: 280, height: 220 },
  right: { x: 336, y: 24, width: 280, height: 220 },
  overlay: { x: 180, y: 60, width: 220, height: 140 },
}
function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Expected record')
  return input as Record<string, unknown>
}
function identity(input: unknown): asserts input is string {
  assert.ok(typeof input === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input))
}
function pageSummary(page: CompositionPage) {
  const { sequence, width, height, visibility, focused } = page
  return { sequence, width, height, visibility, focused }
}

export function acceptCompositionReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 16 * 1024)
  assert.equal(receipt['event'], 'bunly.native.view-composition')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  for (const key of [
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[key], false)
  const observations = record(receipt['observations'])
  assert.equal(observations['resizeTransitions'], 16)
  assert.equal(observations['generationReattachments'], 2)
  assert.deepEqual(observations['checks'], {
    hiddenFocusRejected: true,
    clippedFocusRejected: true,
    nonfocusableRejected: true,
    overlayNavigationRejected: true,
    retiredGenerationRejected: true,
    siblingSurvived: true,
    staleViewRejected: true,
  })
  assert.deepEqual(observations['focusOrder'], [
    'left',
    'right',
    'left',
    'right',
    'left',
    'right',
    'overlay',
    'right',
  ])
  const pages = record(observations['pages'])
  assert.deepEqual(Object.keys(pages).sort(), [...panes].sort())
  const documents = new Map<Pane, { initial: CompositionPage; final: CompositionPage }>()
  const identities = ['viewId', 'sessionId', 'documentId'].map(() => new Set<string>())
  const instances = new Set<string>()
  for (const pane of panes) {
    const value = record(pages[pane])
    assert.deepEqual(Object.keys(value).sort(), [
      'documentId',
      'final',
      'initial',
      'observations',
      'sessionId',
      'viewId',
    ])
    for (const [index, key] of ['viewId', 'sessionId', 'documentId'].entries()) {
      identity(value[key])
      identities[index]!.add(value[key])
    }
    const initial = parseCompositionPage(value['initial'])
    const final = parseCompositionPage(value['final'])
    assert.equal(initial.pane, pane)
    assert.equal(final.pane, pane)
    assert.equal(final.instance, initial.instance, 'Document identity changed')
    instances.add(initial.instance)
    for (const page of [initial, final]) {
      assert.equal(page.form, compositionMarker(pane))
      assert.equal(page.session, compositionMarker(pane))
      assert.equal(page.visibility, 'visible')
      assert.ok(page.width > 0 && page.height > 0)
    }
    assert.ok(final.sequence > initial.sequence)
    assert.equal(value['observations'], final.sequence + 1)
    assert.equal(final.devicePixelRatio, initial.devicePixelRatio)
    documents.set(pane, { initial, final })
  }
  assert.equal(instances.size, 3)
  for (const values of identities) assert.equal(values.size, 3)
  const steps = observations['steps']
  assert.ok(Array.isArray(steps))
  assert.deepEqual(
    steps.map((step: unknown) => {
      const row = record(step)
      return [row['name'], row['pane']]
    }),
    compositionSteps
  )
  const sequences = new Map<Pane, number>()
  const last = new Map<Pane, ReturnType<typeof pageSummary>>()
  for (const item of steps) {
    const row = record(item)
    assert.deepEqual(Object.keys(row).sort(), ['name', 'native', 'page', 'pane'])
    const name = String(row['name'])
    const pane = row['pane'] as Pane
    const document = documents.get(pane)!
    const page = record(row['page'])
    assert.deepEqual(Object.keys(page).sort(), [
      'focused',
      'height',
      'sequence',
      'visibility',
      'width',
    ])
    const parsedPage = parseCompositionPage({ ...document.initial, ...page })
    assert.ok(parsedPage.sequence >= (sequences.get(pane) ?? document.initial.sequence))
    assert.ok(parsedPage.sequence <= document.final.sequence)
    sequences.set(pane, parsedPage.sequence)
    last.set(pane, pageSummary(parsedPage))
    const native = parseViewPresentationState(row['native'])
    assert.equal(native.layer, pane === 'overlay' ? 'overlay' : 'content')
    const hidden = ['hidden-pane', 'overlay-hidden', 'fully-clipped-pane'].includes(name)
    const expected = { ...rectangles[pane] }
    if (name === 'rapid-resize-final') expected.width = 285
    if (name === 'overlay-before-close') expected.width = 221
    if (name === 'sibling-after-overlay-close') expected.width = 281
    if (name.startsWith('final-')) expected.width = 282
    const clip =
      name === 'clipped-viewport'
        ? { x: 44, y: 40, width: 196, height: 164 }
        : name === 'fully-clipped-pane'
          ? { x: 1200, y: 1200, width: 10, height: 10 }
          : null
    assert.deepEqual(native.presentation, {
      bounds: expected,
      clip,
      visible: name !== 'hidden-pane' && name !== 'overlay-hidden',
      focusable: name !== 'nonfocusable-pane',
      tabIndex: panes.indexOf(pane),
    })
    assert.equal(native.visible, !hidden)
    assert.equal(native.drawn, !hidden)
    assert.equal(native.focusable, !hidden && name !== 'nonfocusable-pane')
    assert.equal(parsedPage.visibility, hidden ? 'hidden' : 'visible')
    if (hidden) {
      assert.equal(native.viewport.width, 0)
      assert.equal(native.viewport.height, 0)
      assert.equal(native.focused, false)
      assert.equal(parsedPage.focused, false)
    } else {
      assert.equal(native.viewport.width, parsedPage.width)
      assert.equal(native.viewport.height, parsedPage.height)
      assert.ok(parsedPage.width > 0 && parsedPage.height > 0)
      if (name === 'window-clips-pane') {
        assert.deepEqual({ ...native.viewport, width: 280 }, rectangles.right)
        assert.ok(native.viewport.width < 280)
      } else assert.deepEqual(native.viewport, clip ?? expected)
    }
    if (
      name.startsWith('focus-') ||
      ['forward-tab-order', 'reverse-tab-order', 'resize-preserves-sibling-focus'].includes(name)
    ) {
      assert.equal(native.focused, true)
      assert.equal(parsedPage.focused, true)
    }
    if (name === 'nonfocusable-pane') {
      assert.equal(native.focused, false)
      assert.equal(parsedPage.focused, false)
    }
  }
  for (const pane of panes)
    assert.deepEqual(last.get(pane), pageSummary(documents.get(pane)!.final))
  assert.deepEqual(receipt['nativeFinal'], {
    windows: 1,
    views: 0,
    sessions: 0,
    pending: 0,
    nativeDeliveryPackets: 0,
    nativeDeliveryBytes: 0,
    rpcIncomingBytes: 0,
    streamIncomingBytes: 0,
  })
  return Object.freeze({
    panes: 3,
    steps: compositionSteps.length,
    resizeTransitions: 16,
    generationReattachments: 2,
    focusTransfers: 8,
    retainedDocuments: 3,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  })
}

export function acceptViewComposition(input: unknown) {
  return acceptDesktopObservation(input, 'bunly.native.view-composition', acceptCompositionReceipt)
}

export function acceptCompositionReport(input: unknown) {
  return acceptDesktopEvidence(input, COMPOSITION_PROFILE, requiredSources, acceptViewComposition)
}

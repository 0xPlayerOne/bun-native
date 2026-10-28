import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  acceptCompositionReceipt,
  acceptCompositionReport,
  acceptViewComposition,
  COMPOSITION_PROFILE,
  compositionSteps,
} from '../benchmarks/desktop/composition-acceptance.ts'
import { desktopProfile, desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'
import {
  compositionMarker,
  panes,
  type CompositionPage,
  type Pane,
} from '../examples/view-composition/contract.ts'

/** Parser fixtures only. These values are never native acceptance evidence. */
function receipt() {
  const boxes = {
    left: { x: 24, y: 24, width: 280, height: 220 },
    right: { x: 336, y: 24, width: 280, height: 220 },
    overlay: { x: 180, y: 60, width: 220, height: 140 },
  }
  const initial = (pane: Pane): CompositionPage => ({
    pane,
    sequence: 0,
    instance: `${panes.indexOf(pane) + 1}2345678-1234-1234-1234-123456789abc`,
    width: boxes[pane].width,
    height: boxes[pane].height,
    visibility: 'visible',
    focused: false,
    form: compositionMarker(pane),
    session: compositionMarker(pane),
    devicePixelRatio: 1,
  })
  const pages = Object.fromEntries(
    panes.map((pane, index) => [
      pane,
      {
        viewId: `view-${index}`,
        sessionId: `session-${index}`,
        documentId: `document-${index}`,
        initial: initial(pane),
        final: initial(pane),
        observations: 1,
      },
    ])
  ) as Record<
    Pane,
    {
      viewId: string
      sessionId: string
      documentId: string
      initial: CompositionPage
      final: CompositionPage
      observations: number
    }
  >
  const steps = compositionSteps.map(([name, pane]) => {
    const hidden = ['hidden-pane', 'overlay-hidden', 'fully-clipped-pane'].includes(name)
    const bounds = { ...boxes[pane] }
    if (name === 'rapid-resize-final') bounds.width = 285
    if (name === 'overlay-before-close') bounds.width = 221
    if (name === 'sibling-after-overlay-close') bounds.width = 281
    if (name.startsWith('final-')) bounds.width = 282
    const clip =
      name === 'clipped-viewport'
        ? { x: 44, y: 40, width: 196, height: 164 }
        : name === 'fully-clipped-pane'
          ? { x: 1200, y: 1200, width: 10, height: 10 }
          : null
    const viewport = { ...(clip ?? bounds) }
    if (hidden) {
      viewport.width = 0
      viewport.height = 0
    }
    if (name === 'window-clips-pane') viewport.width = 164
    const focused =
      name === 'final-right' ||
      name.startsWith('focus-') ||
      ['forward-tab-order', 'reverse-tab-order', 'resize-preserves-sibling-focus'].includes(name)
    const page = {
      sequence: pages[pane].observations++,
      width: hidden ? bounds.width : viewport.width,
      height: hidden ? bounds.height : viewport.height,
      visibility: hidden ? ('hidden' as const) : ('visible' as const),
      focused,
    }
    pages[pane].final = { ...pages[pane].initial, ...page }
    return {
      name,
      pane,
      page,
      native: {
        presentation: {
          bounds,
          clip,
          visible: name !== 'hidden-pane' && name !== 'overlay-hidden',
          focusable: name !== 'nonfocusable-pane',
          tabIndex: panes.indexOf(pane),
        },
        viewport,
        layer: pane === 'overlay' ? 'overlay' : 'content',
        visible: !hidden,
        drawn: !hidden,
        focused,
        focusable: !hidden && name !== 'nonfocusable-pane',
      },
    }
  })
  return {
    event: 'bunly.native.view-composition',
    schema: 1,
    passed: true,
    failure: null,
    pendingObservation: null,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
    observations: {
      steps,
      pages,
      resizeTransitions: 16,
      generationReattachments: 2,
      focusOrder: ['left', 'right', 'left', 'right', 'left', 'right', 'overlay', 'right'],
      checks: {
        hiddenFocusRejected: true,
        clippedFocusRejected: true,
        nonfocusableRejected: true,
        overlayNavigationRejected: true,
        retiredGenerationRejected: true,
        siblingSurvived: true,
        staleViewRejected: true,
      },
    },
    nativeFinal: {
      windows: 1,
      views: 0,
      sessions: 0,
      pending: 0,
      nativeDeliveryPackets: 0,
      nativeDeliveryBytes: 0,
      rpcIncomingBytes: 0,
      streamIncomingBytes: 0,
    },
  }
}
function report() {
  const value = receipt()
  return desktopReportFixture({
    receipt: value,
    acceptance: acceptCompositionReceipt(value),
    profile: COMPOSITION_PROFILE,
    sourcePaths: [
      'packages/contracts/src/view-composition.ts',
      'native/cef-host/src/view_composition.rs',
      'examples/view-composition/fixture.ts',
      'examples/view-composition/client.ts',
      'examples/view-composition/contract.ts',
      'examples/view-composition/lifetime.ts',
      'examples/managed-desktop/document-readiness.ts',
      'benchmarks/desktop/composition-acceptance.ts',
    ],
  })
}

test('composition requires three distinct retained documents and the complete native sequence', () => {
  const accepted = acceptCompositionReceipt(receipt())
  assert.equal(accepted.steps, 28)
  assert.equal(accepted.focusTransfers, 8)
  assert.equal(accepted.retainedDocuments, 3)
  assert.equal(accepted.performanceEligible, false)
  acceptCompositionReport(report())
})

test('composition rejects missing/reordered steps, focus transfer and false completion counters', () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => r.observations.steps.splice(1, 1),
    (r: ReturnType<typeof receipt>) => r.observations.steps.reverse(),
    (r: ReturnType<typeof receipt>) => r.observations.focusOrder.pop(),
    (r: ReturnType<typeof receipt>) => {
      r.observations.resizeTransitions = 15
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.generationReattachments = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.checks.overlayNavigationRejected = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.checks.siblingSurvived = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.checks.retiredGenerationRejected = false
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptCompositionReceipt(value))
  }
})

test('composition rejects reloaded documents, shared sessions, lost state and stale page observations', () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => {
      r.observations.pages.left.final = {
        ...r.observations.pages.left.final,
        instance: 'a2345678-1234-1234-1234-123456789abc',
      }
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.pages.left.sessionId = r.observations.pages.right.sessionId
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.pages.left.final = { ...r.observations.pages.left.final, form: '' }
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.pages.right.final = { ...r.observations.pages.right.final, session: '' }
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.pages.overlay.observations++
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.steps.at(-1)!.page.sequence = 0
    },
    (r: ReturnType<typeof receipt>) => {
      r.observations.pages.left.documentId = ''
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptCompositionReceipt(value))
  }
})

test('composition cannot reuse one page sequence for contradictory viewport, visibility or focus', () => {
  const value = receipt()
  for (const step of value.observations.steps) step.page.sequence = 1
  for (const pane of panes) {
    value.observations.pages[pane].final = { ...value.observations.pages[pane].final, sequence: 1 }
    value.observations.pages[pane].observations = 2
  }
  assert.throws(() => acceptCompositionReceipt(value))
})

test('composition final resizing cannot steal right-pane focus or claim two focused panes', () => {
  const value = receipt()
  const left = value.observations.steps.find((step) => step.name === 'final-left')!
  left.native.focused = left.page.focused = true
  value.observations.pages.left.final = { ...value.observations.pages.left.final, focused: true }
  assert.throws(() => acceptCompositionReceipt(value))
})

test('composition rejects wrong native geometry, intent-only visibility and focus on hidden surfaces', () => {
  for (const [name, mutate] of [
    [
      'clipped-viewport',
      (s) => {
        s.native.viewport.width++
      },
    ],
    [
      'clipped-viewport',
      (s) => {
        s.native.presentation.clip = null
      },
    ],
    [
      'window-clips-pane',
      (s) => {
        s.native.viewport.width = s.page.width = 280
      },
    ],
    [
      'fully-clipped-pane',
      (s) => {
        s.native.focusable = true
      },
    ],
    [
      'hidden-pane',
      (s) => {
        s.native.focused = true
      },
    ],
    [
      'hidden-pane',
      (s) => {
        s.page.focused = true
      },
    ],
    [
      'overlay-hidden',
      (s) => {
        s.native.drawn = true
      },
    ],
    [
      'focus-left',
      (s) => {
        s.page.focused = false
      },
    ],
    [
      'nonfocusable-pane',
      (s) => {
        s.native.focused = true
      },
    ],
    [
      'overlay-shown',
      (s) => {
        s.native.layer = 'content'
      },
    ],
    [
      'retained-after-generations',
      (s) => {
        s.native.presentation.bounds.width = 285
      },
    ],
    [
      'rapid-resize-final',
      (s) => {
        s.page.width--
      },
    ],
  ] satisfies [
    string,
    (step: ReturnType<typeof receipt>['observations']['steps'][number]) => void,
  ][]) {
    const value = receipt()
    mutate(value.observations.steps.find((step) => step.name === name)!)
    assert.throws(() => acceptCompositionReceipt(value), name)
  }
})

test('composition requires zero owned resources and refuses unsupported hardware or performance claims', () => {
  for (const key of Object.keys(receipt().nativeFinal) as (keyof ReturnType<
    typeof receipt
  >['nativeFinal'])[]) {
    const value = receipt()
    value.nativeFinal[key]++
    assert.throws(() => acceptCompositionReceipt(value))
  }
  for (const key of [
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ] as const) {
    const value = receipt()
    value[key] = true
    assert.throws(() => acceptCompositionReceipt(value))
  }
})

test('composition shares immutable source and artifact checks and rejects a window report', () => {
  for (const key of ['sourceHashes', 'nativeSource', 'preparedArtifact', 'observation']) {
    const value = report()
    delete value[key]
    assert.throws(() => acceptCompositionReport(value), key)
  }
  const incomplete = report()
  for (const key of ['sourceHashes', 'sourceHashesAfter'])
    incomplete[key] = (incomplete[key] as { path: string }[]).filter(
      (entry) => !entry.path.startsWith('examples/view-composition')
    )
  assert.throws(() => acceptCompositionReport(incomplete))
  const mismatch = report()
  mismatch['profile'] = desktopProfile().profile
  assert.throws(() => acceptCompositionReport(mismatch))
  const duplicate = report()['observation'] as { stderr: string[] }
  duplicate.stderr.push(JSON.stringify(receipt()))
  assert.throws(() => acceptViewComposition(duplicate))
  const noShutdown = report()['observation'] as { stderr: string[] }
  noShutdown.stderr = [JSON.stringify(receipt())]
  assert.throws(() => acceptViewComposition(noShutdown))
})

test('desktop profile selection preserves window replay and requires explicit composition sources', () => {
  assert.equal(desktopProfile().profile, 'native-desktop-controls-v1')
  assert.equal(desktopReportProfile(COMPOSITION_PROFILE), desktopProfile('composition'))
  assert.throws(() => desktopProfile('unknown'))
  assert.throws(() => desktopReportProfile('unknown'))
  assert.ok(
    !desktopProfile().sourceSelectors.some((value: string) => value === 'examples/view-composition')
  )
  assert.ok(
    desktopProfile('composition').sourceSelectors.some(
      (value: string) => value === 'examples/view-composition'
    )
  )
  const events = JSON.parse(
    readFileSync(
      new URL('../benchmarks/lib/native-diagnostic-events.json', import.meta.url),
      'utf8'
    )
  ) as string[]
  assert.equal(events.filter((event) => event === 'bunly.native.view-composition').length, 1)
})

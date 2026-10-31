import assert from 'node:assert/strict'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { validateCommandObservation } from '../lib/observed-command.ts'
import {
  compositionMarker,
  panes,
  parseCompositionPage,
} from '../../examples/view-composition/contract.ts'
import {
  COMPOSITION_INTERACTION_WORKLOAD_MS,
  interactionMenuEvents,
  interactionSteps,
} from '../../examples/view-composition/interactions-plan.ts'
import { requireInitialObservation } from '../../examples/view-composition/initial-observation.ts'
import { acceptDesktopEvidence, acceptDesktopObservation } from './acceptance.ts'
import { compositionSourceSelectors } from './composition-acceptance.ts'

export const LEGACY_COMPOSITION_INTERACTIONS_PROFILE = 'native-composition-interactions-v1'
export const COMPOSITION_INTERACTIONS_PROFILE = 'native-composition-interactions-v2'
export const compositionInteractionSourceSelectors = [
  ...compositionSourceSelectors,
  'examples/window-commands/observations.ts',
] as const
export const compositionInteractionRequiredSourcesV1 = [
  'packages/contracts/src/view-composition.ts',
  'packages/contracts/src/window-commands.ts',
  'packages/runtime/src/cef.ts',
  'packages/runtime/src/cef-dialogs.ts',
  'packages/runtime/src/cef-window-commands.ts',
  'native/cef-host/src/view_composition.rs',
  'native/cef-host/src/window_commands.rs',
  'native/cef-host/src/native_modal.rs',
  'native/cef-host/src/dialogs.rs',
  'native/cef-host/src/dialogs_macos.rs',
  'examples/view-composition/interactions.ts',
  'examples/view-composition/interactions-plan.ts',
  'examples/view-composition/client.ts',
  'examples/view-composition/contract.ts',
  'examples/view-composition/lifetime.ts',
  'examples/view-composition/public/index.html',
  'examples/window-commands/observations.ts',
  'examples/managed-desktop/document-readiness.ts',
  'benchmarks/desktop/composition-interactions.ts',
  'benchmarks/desktop/profiles.ts',
  'benchmarks/lib/native-diagnostic-events.json',
  'scripts/qualify-desktop.ts',
  'scripts/hosted_cef.py',
  'scripts/qualify-cef-window-modes-linux.py',
] as const
export const compositionInteractionRequiredSources = [
  ...compositionInteractionRequiredSourcesV1,
  'examples/view-composition/initial-observation.ts',
  'examples/view-composition/initial-observation-host.ts',
  'examples/view-composition/public/initial-observation.js',
] as const

function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Expected record')
  return input as Record<string, unknown>
}
function fields(input: unknown, names: readonly string[]) {
  const value = record(input)
  assert.deepEqual(Object.keys(value).sort(), [...names].sort())
  return value
}

/** Historical v1 replay only: no observation of application state before RPC startup. */
export function acceptCompositionInteractionReceiptV1(input: unknown) {
  const receipt = fields(input, [
    'event',
    'schema',
    'passed',
    'failure',
    'workloadMs',
    'focus',
    'pendingFocus',
    'menus',
    'dialog',
    'pages',
    'hiddenFocusRejected',
    'menuFinal',
    'nativeFinal',
    'sdkFinal',
    'shutdownSucceeded',
    'physicalInputQualified',
    'imeQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 16 * 1024)
  assert.equal(receipt['event'], 'bunly.native.composition-interactions')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.equal(receipt['pendingFocus'], null)
  assert.ok(
    typeof receipt['workloadMs'] === 'number' &&
      Number.isFinite(receipt['workloadMs']) &&
      receipt['workloadMs'] > 0 &&
      receipt['workloadMs'] <= COMPOSITION_INTERACTION_WORKLOAD_MS
  )
  assert.equal(receipt['hiddenFocusRejected'], true)
  assert.equal(receipt['shutdownSucceeded'], true)
  for (const flag of [
    'physicalInputQualified',
    'imeQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[flag], false)

  const dialog = fields(receipt['dialog'], [
    'status',
    'before',
    'visible',
    'after',
    'menuRejectedWhileOpen',
  ])
  assert.ok(dialog['status'] === 'cancelled' || dialog['status'] === 'unsupported')
  const supported = dialog['status'] === 'cancelled'
  const empty = {
    supported,
    active: 0,
    visible: false,
    admissions: 0,
    callbacks: 0,
    selected: 0,
    cancelled: 0,
    failed: 0,
  }
  assert.deepEqual(dialog['before'], empty)
  assert.deepEqual(
    dialog['visible'],
    supported ? { ...empty, active: 1, visible: true, admissions: 1 } : null
  )
  assert.deepEqual(
    dialog['after'],
    supported ? { ...empty, admissions: 1, callbacks: 1, cancelled: 1 } : empty
  )
  assert.equal(dialog['menuRejectedWhileOpen'], supported)

  assert.deepEqual(
    receipt['menus'],
    panes.map((pane) => ({ pane, events: interactionMenuEvents }))
  )
  const pages = fields(receipt['pages'], panes)
  const documents = new Map(
    panes.map((pane) => {
      const row = fields(pages[pane], ['viewId', 'sessionId', 'documentId', 'initial', 'final'])
      for (const key of ['viewId', 'sessionId', 'documentId'])
        assert.ok(typeof row[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row[key]))
      const initial = parseCompositionPage(row['initial'])
      const final = parseCompositionPage(row['final'])
      for (const page of [initial, final]) {
        assert.equal(page.pane, pane)
        assert.equal(page.form, compositionMarker(pane))
        assert.equal(page.session, compositionMarker(pane))
      }
      assert.equal(initial.instance, final.instance, 'Document instance changed')
      assert.equal(initial.devicePixelRatio, final.devicePixelRatio)
      assert.ok(final.sequence > initial.sequence)
      assert.equal(final.width, pane === 'overlay' ? 221 : 281)
      assert.equal(final.height, pane === 'overlay' ? 140 : 220)
      assert.equal(final.visibility, 'visible')
      return [pane, { initial, final }]
    })
  )
  for (const key of ['viewId', 'sessionId', 'documentId'])
    assert.equal(new Set(panes.map((pane) => record(pages[pane])[key])).size, 3)
  assert.equal(new Set([...documents.values()].map((value) => value.initial.instance)).size, 3)

  const expected = interactionSteps.filter(
    (step) => supported || step.name !== 'overlay-dialog-closed'
  )
  const focus = receipt['focus']
  assert.ok(Array.isArray(focus))
  assert.deepEqual(
    focus.map((entry: unknown) => record(entry)['name']),
    expected.map((step) => step.name)
  )
  const previous = new Map(
    panes.map((pane) => {
      const initial = documents.get(pane)!.initial
      return [
        pane,
        { sequence: initial.sequence, focused: initial.focused, visibility: initial.visibility },
      ]
    })
  )
  for (const [index, value] of focus.entries()) {
    const row = fields(value, ['name', 'panes'])
    const states = fields(row['panes'], panes)
    const step = expected[index]!
    for (const pane of panes) {
      const state = fields(states[pane], [
        'nativeFocused',
        'pageFocused',
        'visible',
        'drawn',
        'focusable',
        'pageVisibility',
        'sequence',
      ])
      const visible = pane !== 'overlay' || step.overlayVisible
      const focused = pane === step.focused
      for (const key of ['visible', 'drawn', 'focusable']) assert.equal(state[key], visible)
      assert.equal(state['nativeFocused'], focused)
      assert.equal(state['pageFocused'], focused)
      assert.equal(state['pageVisibility'], visible ? 'visible' : 'hidden')
      const prior = previous.get(pane)!
      const sequence = state['sequence']
      assert.ok(
        Number.isSafeInteger(sequence) &&
          Number(sequence) >= prior.sequence &&
          Number(sequence) < documents.get(pane)!.final.sequence
      )
      if (sequence === prior.sequence) {
        assert.equal(focused, prior.focused, 'One page sequence cannot change focus')
        assert.equal(
          state['pageVisibility'],
          prior.visibility,
          'One page sequence cannot change visibility'
        )
      }
      previous.set(pane, {
        sequence: Number(sequence),
        focused,
        visibility: visible ? 'visible' : 'hidden',
      })
    }
  }
  assert.deepEqual(receipt['menuFinal'], { registrations: 0, shortcuts: 0, popups: 0 })
  assert.deepEqual(receipt['nativeFinal'], {
    windows: 1,
    views: 0,
    sessions: 0,
    rpcBindings: 0,
    pending: 0,
    downloads: 0,
    nativeDeliveryPackets: 0,
    nativeDeliveryBytes: 0,
    rpcIncomingBytes: 0,
    streamIncomingBytes: 0,
  })
  assert.deepEqual(receipt['sdkFinal'], {
    windows: 0,
    views: 0,
    sessions: 0,
    listeners: 0,
    listenerErrors: 0,
  })
  return Object.freeze({
    panes: 3,
    focusObservations: expected.length,
    cancelledMenus: 3,
    dialog: supported ? ('cancelled' as const) : ('unsupported' as const),
    menuRejectedWhileDialogOpen: supported,
    retainedDocuments: 3,
    nativeOwnershipReleased: true,
    physicalInputQualified: false,
    imeQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  })
}

export function acceptCompositionInteractionReceipt(input: unknown) {
  const receipt = record(input)
  assert.equal(receipt['schema'], 2, 'Current interaction execution requires schema 2')
  // The per-pane history bound does not guarantee the aggregate fits the
  // existing native diagnostic transport. Reject oversized receipts in full.
  assert.ok(
    Buffer.byteLength(JSON.stringify(receipt)) <= 16 * 1024,
    'Interaction receipt exceeds native diagnostic budget'
  )
  const { initialObservation, ...priorSections } = receipt
  const accepted = acceptCompositionInteractionReceiptV1({ ...priorSections, schema: 1 })
  const initial = fields(initialObservation, ['panes', 'creation'])
  const histories = fields(initial['panes'], panes)
  const pages = record(receipt['pages'])
  for (const pane of panes) {
    const sample = fields(histories[pane], ['viewId', 'documentId', 'history'])
    const page = record(pages[pane])
    assert.equal(sample['viewId'], page['viewId'], 'Initial observation changed native view')
    assert.equal(
      sample['documentId'],
      page['documentId'],
      'Initial observation changed native document'
    )
    const history = requireInitialObservation(sample['history'])
    assert.equal(history.pane, pane)
    assert.equal(history.instance, record(page['initial'])['instance'])
  }
  const creation = fields(initial['creation'], ['before', 'after'])
  for (const [phase, names] of [
    ['before', ['left', 'right']],
    ['after', panes],
  ] as const) {
    const states = fields(creation[phase], names)
    for (const pane of names) {
      const visible = pane !== 'overlay'
      assert.deepEqual(states[pane], {
        visible,
        drawn: visible,
        focusable: visible,
        nativeFocused: pane === 'right',
        pageVisibility: visible ? 'visible' : 'hidden',
        pageFocused: pane === 'right',
      })
    }
  }
  return Object.freeze({
    ...accepted,
    initialVisibilityObserved: true,
    creationFocusPreserved: true,
  })
}

function acceptInteractionObservation(
  input: unknown,
  acceptReceipt: typeof acceptCompositionInteractionReceiptV1
) {
  const observation = validateCommandObservation(input)
  const result = acceptDesktopObservation(
    observation,
    'bunly.native.composition-interactions',
    acceptReceipt
  )
  assert.equal(
    result.dialog,
    observation.environment['os'] === 'Darwin' ? 'cancelled' : 'unsupported'
  )
  const events = nativeEvents(observation)
  const receipt = events.findIndex(
    (event) => event['event'] === 'bunly.native.composition-interactions'
  )
  const processStop = events.findIndex(
    (event) =>
      event['event'] === 'bunly.host.shutdown-phase' &&
      event['phase'] === 'process-stop' &&
      event['state'] === 'start'
  )
  const backendExit = events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  assert.ok(
    processStop < receipt && receipt < backendExit,
    'Interaction receipt must follow actual shutdown and precede backend exit'
  )
  return result
}

export function acceptCompositionInteractionsV1(input: unknown) {
  return acceptInteractionObservation(input, acceptCompositionInteractionReceiptV1)
}

export function acceptCompositionInteractions(input: unknown) {
  return acceptInteractionObservation(input, acceptCompositionInteractionReceipt)
}

export function acceptCompositionInteractionReportV1(input: unknown) {
  return acceptDesktopEvidence(
    input,
    LEGACY_COMPOSITION_INTERACTIONS_PROFILE,
    compositionInteractionRequiredSourcesV1,
    acceptCompositionInteractionsV1
  )
}

export function acceptCompositionInteractionReport(input: unknown) {
  return acceptDesktopEvidence(
    input,
    COMPOSITION_INTERACTIONS_PROFILE,
    compositionInteractionRequiredSources,
    acceptCompositionInteractions
  )
}

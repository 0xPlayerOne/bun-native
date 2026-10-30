import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import {
  COMPOSITION_INTERACTIONS_PROFILE,
  LEGACY_COMPOSITION_INTERACTIONS_PROFILE,
  acceptCompositionInteractionReceipt,
  acceptCompositionInteractionReport,
  acceptCompositionInteractions,
  compositionInteractionRequiredSources,
  acceptCompositionInteractionReceiptV1,
  acceptCompositionInteractionReportV1,
} from '../benchmarks/desktop/composition-interactions.ts'
import { desktopProfile, desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import { compositionMarker, panes } from '../examples/view-composition/contract.ts'
import {
  COMPOSITION_INTERACTION_WORKLOAD_MS,
  interactionMenuEvents,
  interactionSteps,
} from '../examples/view-composition/interactions-plan.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'
import { hasCode } from '../examples/view-composition/interactions.ts'
import type {
  InitialObservation,
  InitialObservationEvent,
} from '../examples/view-composition/initial-observation.ts'

// Synthetic rejection fixtures only; these are not native qualification evidence.
function receipt(supported = false) {
  const steps = interactionSteps.filter(
    (step) => supported || step.name !== 'overlay-dialog-closed'
  )
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
  return {
    event: 'bunly.native.composition-interactions',
    schema: 2,
    passed: true,
    failure: null as string | null,
    pendingFocus: null as unknown,
    workloadMs: 1000,
    hiddenFocusRejected: true,
    shutdownSucceeded: true,
    initialObservation: {
      panes: Object.fromEntries(
        panes.map((pane, index) => {
          const event = (
            name: InitialObservationEvent['event'],
            focused = pane === 'right'
          ): InitialObservationEvent => ({
            event: name,
            visibility: pane === 'overlay' ? 'hidden' : 'visible',
            focused,
            trusted: name === 'focus' ? true : null,
          })
          return [
            pane,
            {
              viewId: `view-${pane}`,
              documentId: `document-${pane}`,
              history: {
                pane,
                instance: `00000000-0000-4000-8000-00000000000${index}`,
                phase: 'before-show',
                overflow: false as boolean,
                events: [
                  event('initial', false),
                  ...(pane === 'right' ? [event('focus')] : []),
                  ...(pane === 'overlay' ? [] : [event('before-create')]),
                  event('after-create'),
                  event('before-show'),
                ],
              } satisfies InitialObservation,
            },
          ]
        })
      ),
      creation: Object.fromEntries(
        (['before', 'after'] as const).map((phase) => [
          phase,
          Object.fromEntries(
            panes
              .filter((pane) => phase === 'after' || pane !== 'overlay')
              .map((pane) => [
                pane,
                {
                  visible: pane !== 'overlay',
                  drawn: pane !== 'overlay',
                  focusable: pane !== 'overlay',
                  nativeFocused: pane === 'right',
                  pageVisibility: pane === 'overlay' ? 'hidden' : 'visible',
                  pageFocused: pane === 'right',
                },
              ])
          ),
        ])
      ),
    },
    focus: steps.map((step, index) => ({
      name: step.name,
      panes: Object.fromEntries(
        panes.map((pane) => {
          const visible = pane !== 'overlay' || step.overlayVisible
          return [
            pane,
            {
              nativeFocused: pane === step.focused,
              pageFocused: pane === step.focused,
              visible,
              drawn: visible,
              focusable: visible,
              pageVisibility: visible ? 'visible' : 'hidden',
              sequence: index + 1,
            },
          ]
        })
      ),
    })),
    menus: panes.map((pane) => ({
      pane,
      events: interactionMenuEvents.map((event) => ({ ...event })),
    })),
    dialog: {
      status: supported ? 'cancelled' : 'unsupported',
      before: empty,
      visible: supported ? { ...empty, active: 1, visible: true, admissions: 1 } : null,
      after: supported ? { ...empty, admissions: 1, callbacks: 1, cancelled: 1 } : empty,
      menuRejectedWhileOpen: supported,
    },
    pages: Object.fromEntries(
      panes.map((pane, index) => {
        const initial = {
          pane,
          sequence: 0,
          instance: `00000000-0000-4000-8000-00000000000${index}`,
          width: pane === 'overlay' ? 220 : 280,
          height: pane === 'overlay' ? 140 : 220,
          visibility: pane === 'overlay' ? 'hidden' : 'visible',
          focused: false,
          form: compositionMarker(pane),
          session: compositionMarker(pane),
          devicePixelRatio: 1,
        }
        return [
          pane,
          {
            viewId: `view-${pane}`,
            sessionId: `session-${pane}`,
            documentId: `document-${pane}`,
            initial,
            final: {
              ...initial,
              sequence: steps.length + 2,
              width: initial.width + 1,
              visibility: 'visible',
            },
          },
        ]
      })
    ),
    menuFinal: { registrations: 0, shortcuts: 0, popups: 0 },
    nativeFinal: {
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
    },
    sdkFinal: { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    physicalInputQualified: false,
    imeQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  }
}
function report(target = 'linux-x64') {
  const value = receipt(target === 'darwin-arm64')
  const result = desktopReportFixture({
    receipt: value,
    acceptance: acceptCompositionInteractionReceipt(value),
    profile: COMPOSITION_INTERACTIONS_PROFILE,
    target,
    sourcePaths: compositionInteractionRequiredSources.filter(
      (path) => path !== 'packages/runtime/src/cef.ts' && path !== 'scripts/qualify-desktop.ts'
    ),
  })
  const observation = result['observation'] as { stderr: string[] }
  const application = observation.stderr.shift()!
  observation.stderr.splice(1, 0, application)
  return result
}

test('hidden focus accepts only its exact native denial or the matching structured SDK code', () => {
  const message = 'view is hidden, clipped or nonfocusable'
  const expected = hasCode('PERMISSION_DENIED', message)
  const native = new Error(`PERMISSION_DENIED: ${message}`)
  assert.equal(expected(native), true)
  assert.equal(
    hasCode('PERMISSION_DENIED')(native),
    false,
    'Native fallback requires explicit opt-in'
  )
  assert.equal(
    expected(
      Object.assign(new Error('SDK denial'), { name: 'BunlyError', code: 'PERMISSION_DENIED' })
    ),
    true
  )
  for (const error of [
    new Error('PERMISSION_DENIED: focus target changed during activation'),
    new Error(`INVALID_ARGUMENT: ${message}`),
    new Error(`prefix PERMISSION_DENIED: ${message}`),
    new Error(`PERMISSION_DENIED_EXTRA: ${message}`),
    new Error(`PERMISSION_DENIED:${message}`),
    new TypeError(`PERMISSION_DENIED: ${message}`),
    Object.assign(new Error(`PERMISSION_DENIED: ${message}`), { code: 'INVALID_ARGUMENT' }),
    Object.assign(new Error(`PERMISSION_DENIED: ${message}`), {
      name: 'BunlyError',
      code: 'INVALID_ARGUMENT',
    }),
    { name: 'BunlyError', code: 'PERMISSION_DENIED' },
    `PERMISSION_DENIED: ${message}`,
    null,
  ])
    assert.equal(expected(error), false)
})

test('composition interactions require native and renderer agreement for each focus owner', () => {
  for (const supported of [false, true]) {
    const value = receipt(supported)
    const accepted = acceptCompositionInteractionReceipt(value)
    assert.equal(accepted.focusObservations, supported ? 10 : 9)
    assert.equal(accepted.dialog, supported ? 'cancelled' : 'unsupported')
    assert.equal(accepted.cancelledMenus, 3)
  }
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => r.focus.pop(),
    (r: ReturnType<typeof receipt>) => r.focus.reverse(),
    (r: ReturnType<typeof receipt>) => {
      r.focus[1]!.panes['left']!.nativeFocused = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.focus[1]!.panes['left']!.pageFocused = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.focus[1]!.panes['right']!.nativeFocused = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.focus[1]!.panes['overlay']!.focusable = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.focus[1]!.panes['overlay']!.pageVisibility = 'visible'
    },
    (r: ReturnType<typeof receipt>) => {
      r.focus[2]!.panes['left']!.sequence = r.focus[1]!.panes['left']!.sequence
    },
    (r: ReturnType<typeof receipt>) => {
      r.focus[0]!.panes['left']!.sequence = 127
    },
    (r: ReturnType<typeof receipt>) => {
      r.pages['left']!.final.instance = r.pages['right']!.initial.instance
    },
    (r: ReturnType<typeof receipt>) => {
      r.pages['left']!.documentId = r.pages['right']!.documentId
    },
    (r: ReturnType<typeof receipt>) => {
      r.pages['left']!.final.form = 'lost draft'
    },
    (r: ReturnType<typeof receipt>) => {
      r.pages['left']!.final.sequence = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.pendingFocus = r.focus[0]
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptCompositionInteractionReceipt(value))
  }
})

test('menu and dialog interaction evidence rejects admission-only, reordered and unreleased UI', () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => r.menus.pop(),
    (r: ReturnType<typeof receipt>) => r.menus.reverse(),
    (r: ReturnType<typeof receipt>) => r.menus[0]!.events.pop(),
    (r: ReturnType<typeof receipt>) => {
      r.dialog.after.active = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.dialog.after.visible = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.dialog.after.callbacks = 0
    },
    (r: ReturnType<typeof receipt>) => {
      r.dialog.after.selected = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.dialog.menuRejectedWhileOpen = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.menuFinal.popups = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.nativeFinal.views = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.nativeFinal.nativeDeliveryPackets = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.sdkFinal.listeners = 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.shutdownSucceeded = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.hiddenFocusRejected = false
    },
  ]) {
    const value = receipt(true)
    mutate(value)
    assert.throws(() => acceptCompositionInteractionReceipt(value))
  }
  const unsupported = receipt()
  unsupported.dialog.menuRejectedWhileOpen = true
  assert.throws(() => acceptCompositionInteractionReceipt(unsupported))
})

test('interaction acceptance cannot turn SDK observations into hardware or performance claims', () => {
  for (const flag of [
    'physicalInputQualified',
    'imeQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ] as const) {
    const value = receipt()
    value[flag] = true
    assert.throws(() => acceptCompositionInteractionReceipt(value))
  }
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => {
      r.workloadMs = COMPOSITION_INTERACTION_WORKLOAD_MS + 1
    },
    (r: ReturnType<typeof receipt>) => {
      r.workloadMs = Number.NaN
    },
    (r: ReturnType<typeof receipt>) => {
      r.passed = false
    },
    (r: ReturnType<typeof receipt>) => {
      r.failure = 'native failure'
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptCompositionInteractionReceipt(value))
  }
  assert.throws(() => acceptCompositionInteractionReceipt({ ...receipt(), extra: true }))
})

test('interaction report binds platform, immutable sources, artifact identity and shutdown order', () => {
  for (const target of ['linux-x64', 'win32-x64']) {
    const value = report(target)
    assert.deepEqual(acceptCompositionInteractionReport(value), value['acceptance'])
  }
  for (const mutate of [
    (r: Record<string, unknown>) => {
      r['inputArtifactUnchanged'] = false
    },
    (r: Record<string, unknown>) => {
      r['preparedArtifactUnchanged'] = false
    },
    (r: Record<string, unknown>) => {
      r['sourceHashes'] = (r['sourceHashes'] as { path: string }[]).filter(
        (row) => row.path !== 'native/cef-host/src/native_modal.rs'
      )
      r['sourceHashesAfter'] = structuredClone(r['sourceHashes'])
    },
    (r: Record<string, unknown>) => {
      const observation = r['observation'] as { stderr: string[] }
      observation.stderr.unshift(observation.stderr.splice(1, 1)[0]!)
    },
    (r: Record<string, unknown>) => {
      const observation = r['observation'] as { stderr: string[] }
      observation.stderr[1] = JSON.stringify(receipt(true))
    },
    (r: Record<string, unknown>) => {
      const observation = r['observation'] as { cleanupSurvivors: number[] }
      observation.cleanupSurvivors = [123]
    },
  ]) {
    const value = report()
    mutate(value)
    assert.throws(() => acceptCompositionInteractionReport(value))
  }
  const mac = report('darwin-arm64')
  assert.equal(acceptCompositionInteractions(mac['observation']).dialog, 'cancelled')
  assert.throws(() => acceptCompositionInteractionReport(mac), /cleanup/)
})

test('interaction profile reuses authenticated renderer while preserving historical profiles', async () => {
  const profile = desktopProfile('composition-interactions')
  assert.equal(desktopReportProfile(COMPOSITION_INTERACTIONS_PROFILE), profile)
  assert.ok('applicationEntry' in profile)
  assert.equal(profile.applicationEntry, 'examples/view-composition/interactions.ts')
  assert.equal(profile.browserEntry, 'examples/view-composition/client.ts')
  assert.equal(profile.directory, 'composition-interactions')
  assert.equal(profile.profile, 'native-composition-interactions-v2')
  assert.equal('applicationEntry' in desktopProfile('composition'), false)
  assert.ok(
    !desktopProfile('composition').sourceSelectors.some(
      (path: string) => path === 'examples/window-commands/observations.ts'
    )
  )
  const events = JSON.parse(
    readFileSync(
      new URL('../benchmarks/lib/native-diagnostic-events.json', import.meta.url),
      'utf8'
    )
  ) as string[]
  assert.equal(
    events.filter((event) => event === 'bunly.native.composition-interactions').length,
    1
  )
  for (const path of compositionInteractionRequiredSources)
    assert.equal(await Bun.file(path).exists(), true, `Required source missing: ${path}`)
  const built = await Bun.build({
    entrypoints: [profile.applicationEntry],
    target: 'bun',
  })
  assert.equal(built.success, true, built.logs.join('\n'))
})

test('initial interaction evidence rejects early exposure and transient focus theft', () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['overlay']!.history.events[0] = {
        event: 'initial',
        visibility: 'visible',
        focused: false,
        trusted: null,
      }
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['overlay']!.history.events.splice(
        1,
        0,
        { event: 'visibilitychange', visibility: 'visible', focused: false, trusted: true },
        { event: 'visibilitychange', visibility: 'hidden', focused: false, trusted: true }
      )
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['overlay']!.history.events.splice(
        1,
        0,
        { event: 'focus', visibility: 'hidden', focused: true, trusted: true },
        { event: 'blur', visibility: 'hidden', focused: false, trusted: true }
      )
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['right']!.history.events.splice(
        3,
        0,
        { event: 'blur', visibility: 'visible', focused: false, trusted: true },
        { event: 'focus', visibility: 'visible', focused: true, trusted: true }
      )
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['left']!.history.events.splice(
        2,
        0,
        { event: 'focus', visibility: 'visible', focused: true, trusted: true },
        { event: 'blur', visibility: 'visible', focused: false, trusted: true }
      )
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['overlay']!.history.overflow = true
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['overlay']!.documentId = 'changed-document'
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['overlay']!.viewId = 'changed-view'
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.panes['overlay']!.history.instance = r.pages['left']!.initial.instance
    },
    (r: ReturnType<typeof receipt>) => {
      r.initialObservation.creation['after']!['right']!.nativeFocused = false
    },
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptCompositionInteractionReceipt(value))
  }
  const accepted = acceptCompositionInteractionReceipt(receipt())
  assert.equal(accepted.initialVisibilityObserved, true)
  assert.equal(accepted.creationFocusPreserved, true)
})

test('retained v1 receipts keep their original acceptance and cannot satisfy current execution', () => {
  const { initialObservation: _early, ...priorSections } = receipt()
  const historical = { ...priorSections, schema: 1 }
  const old = acceptCompositionInteractionReceiptV1(historical)
  const current = acceptCompositionInteractionReceipt(receipt())
  const {
    initialVisibilityObserved: _visibility,
    creationFocusPreserved: _focus,
    ...unchanged
  } = current
  assert.deepEqual(old, unchanged)
  assert.throws(() => acceptCompositionInteractionReceipt(historical), /schema 2/)
  assert.throws(() => acceptCompositionInteractionReceiptV1(receipt()))
  const replay = desktopReportProfile(LEGACY_COMPOSITION_INTERACTIONS_PROFILE)
  assert.equal(replay.profile, 'native-composition-interactions-v1')
  assert.equal(replay.acceptReport, acceptCompositionInteractionReportV1)
  assert.match(replay.workloadLimitation, /after RPC startup/)
  assert.equal(desktopProfile('composition').profile, 'native-view-composition-v1')
})

import assert from 'node:assert/strict'
import {
  DESKTOP_PROFILE,
  desktopSourceSelectors,
  acceptDesktopControls,
  acceptDesktopReport,
} from './acceptance.ts'
import {
  COMPOSITION_PROFILE,
  compositionSourceSelectors,
  acceptViewComposition,
  acceptCompositionReport,
} from './composition-acceptance.ts'

const profiles = {
  windows: {
    profile: DESKTOP_PROFILE,
    sourceSelectors: desktopSourceSelectors,
    fixture: 'examples/desktop-controls',
    directory: 'desktop',
    title: 'Desktop Controls',
    workloadLimitation:
      'One fixed functional native-window sequence; actual activation is observed, not guaranteed.',
    acceptObservation: acceptDesktopControls,
    acceptReport: acceptDesktopReport,
  },
  composition: {
    profile: COMPOSITION_PROFILE,
    sourceSelectors: compositionSourceSelectors,
    fixture: 'examples/view-composition',
    directory: 'view-composition',
    title: 'View Composition',
    workloadLimitation:
      'One fixed native three-pane sequence; API focus traversal does not qualify physical keyboard or pointer routing.',
    acceptObservation: acceptViewComposition,
    acceptReport: acceptCompositionReport,
  },
} as const

export function desktopProfile(name = 'windows') {
  assert.ok(name === 'windows' || name === 'composition', 'Unknown desktop qualification case')
  return profiles[name]
}

export function desktopReportProfile(profile: unknown) {
  const selected = Object.values(profiles).find((entry) => entry.profile === profile)
  assert.ok(selected, 'Unknown desktop report profile')
  return selected
}

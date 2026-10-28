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
import {
  SERVICES_PROFILE,
  servicesSourceSelectors,
  acceptDesktopServices,
  acceptServicesReport,
} from './services-acceptance.ts'
import {
  DOWNLOADS_PROFILE,
  downloadsSourceSelectors,
  acceptFileDownloads,
  acceptDownloadsReport,
} from './downloads-acceptance.ts'

const profiles = {
  windows: {
    profile: DESKTOP_PROFILE,
    sourceSelectors: desktopSourceSelectors,
    fixture: 'examples/desktop-controls',
    browserEntry: 'examples/desktop-controls/client.ts',
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
    browserEntry: 'examples/view-composition/client.ts',
    directory: 'view-composition',
    title: 'View Composition',
    workloadLimitation:
      'One fixed native three-pane sequence; API focus traversal does not qualify physical keyboard or pointer routing.',
    acceptObservation: acceptViewComposition,
    acceptReport: acceptCompositionReport,
  },
  services: {
    profile: SERVICES_PROFILE,
    sourceSelectors: servicesSourceSelectors,
    fixture: 'examples/desktop-services',
    browserEntry: null,
    directory: 'desktop-services',
    title: 'Desktop Services',
    workloadLimitation:
      'Clipboard round trips require an initially empty disposable hosted session; Linux explicitly qualifies unsupported clipboard and real application lifecycle only.',
    acceptObservation: acceptDesktopServices,
    acceptReport: acceptServicesReport,
  },
  downloads: {
    profile: DOWNLOADS_PROFILE,
    sourceSelectors: downloadsSourceSelectors,
    fixture: 'examples/file-downloads',
    browserEntry: 'examples/file-downloads/client.ts',
    directory: 'file-downloads',
    title: 'File Downloads',
    workloadLimitation:
      'Fourteen real CEF transfers under exact document grants and private temporary roots; native file input, uploads and OS-file drops remain unsupported.',
    acceptObservation: acceptFileDownloads,
    acceptReport: acceptDownloadsReport,
  },
} as const

export function desktopProfile(name = 'windows') {
  assert.ok(
    name === 'windows' || name === 'composition' || name === 'services' || name === 'downloads',
    'Unknown desktop qualification case'
  )
  return profiles[name]
}

export function desktopReportProfile(profile: unknown) {
  const selected = Object.values(profiles).find((entry) => entry.profile === profile)
  assert.ok(selected, 'Unknown desktop report profile')
  return selected
}

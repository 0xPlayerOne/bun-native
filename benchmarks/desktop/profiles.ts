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
import {
  PARENT_CLOSE_PROFILE,
  parentCloseSourceSelectors,
  acceptParentClose,
  acceptParentCloseReport,
} from './parent-close-acceptance.ts'
import {
  COMMANDS_PROFILE,
  commandsSourceSelectors,
  acceptWindowCommands,
  acceptCommandsReport,
} from './commands-acceptance.ts'

import {
  DIALOGS_PROFILE,
  dialogsSourceSelectors,
  acceptFileDialogs,
  acceptDialogsReport,
} from './dialogs-acceptance.ts'
import {
  STATUS_PROFILE,
  statusSourceSelectors,
  acceptStatusItems,
  acceptStatusReport,
} from './status-acceptance.ts'
import {
  LINKS_PROFILE,
  linksSourceSelectors,
  acceptApplicationLinks,
  acceptApplicationLinksReport,
} from './links-acceptance.ts'

import {
  COMPOSITION_RESOURCE_PROFILE,
  compositionResourceSourceSelectors,
  acceptCompositionResources,
  acceptCompositionResourceReport,
} from './composition-profile.ts'
import {
  COMPOSITION_INTERACTIONS_PROFILE,
  LEGACY_COMPOSITION_INTERACTIONS_PROFILE,
  compositionInteractionSourceSelectors,
  acceptCompositionInteractions,
  acceptCompositionInteractionReport,
  acceptCompositionInteractionsV1,
  acceptCompositionInteractionReportV1,
} from './composition-interactions.ts'

const profiles = {
  'composition-interactions': {
    profile: COMPOSITION_INTERACTIONS_PROFILE,
    sourceSelectors: compositionInteractionSourceSelectors,
    fixture: 'examples/view-composition',
    applicationEntry: 'examples/view-composition/interactions.ts',
    browserEntry: 'examples/view-composition/client.ts',
    directory: 'composition-interactions',
    title: 'Composition Interactions',
    workloadLimitation:
      'Early bounded page visibility/focus history and preserved native focus during hidden overlay creation; three native menu cancellations, explicit focus restoration and supported native file dialog cancellation. Physical input, IME, accessibility and hardware DPI remain unqualified.',
    acceptObservation: acceptCompositionInteractions,
    acceptReport: acceptCompositionInteractionReport,
  },
  'composition-profile': {
    profile: COMPOSITION_RESOURCE_PROFILE,
    sourceSelectors: compositionResourceSourceSelectors,
    fixture: 'examples/composition-profile',
    browserEntry: null,
    directory: 'composition-profile',
    title: 'Composition Resource Profile',
    workloadLimitation:
      'Fixed API-driven windowed-CEF phases with sampled CPU/RSS and operation/readback round trips. No GPU utilization, physical input, presentation latency, OSR comparison or performance qualification.',
    acceptObservation: acceptCompositionResources,
    acceptReport: acceptCompositionResourceReport,
  },
  links: {
    profile: LINKS_PROFILE,
    sourceSelectors: linksSourceSelectors,
    fixture: 'examples/application-links',
    browserEntry: null,
    directory: 'application-links',
    title: 'Application Links',
    workloadLimitation:
      'Three controlled startup arguments, exact route and document authority, acknowledged delivery across managed generations, and native reader/delegate cleanup. OS registration, live OS URL delivery, browser launch and second-instance forwarding remain unqualified.',
    acceptObservation: acceptApplicationLinks,
    acceptReport: acceptApplicationLinksReport,
  },
  status: {
    profile: STATUS_PROFILE,
    sourceSelectors: statusSourceSelectors,
    fixture: 'examples/status-items',
    browserEntry: null,
    directory: 'status-items',
    title: 'Status Items',
    workloadLimitation:
      'Four macOS text status items and two actual AppKit performClick callbacks; Windows/Linux explicitly unsupported. No tray menus, icons, keepalive or physical-input claim.',
    acceptObservation: acceptStatusItems,
    acceptReport: acceptStatusReport,
  },
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
  dialogs: {
    profile: DIALOGS_PROFILE,
    sourceSelectors: dialogsSourceSelectors,
    fixture: 'examples/file-dialogs',
    browserEntry: null,
    directory: 'file-dialogs',
    title: 'File Dialogs',
    workloadLimitation:
      'Six actual macOS panel cancellations; Windows/Linux explicitly unsupported. No file selection, upload, physical input or assistive-technology claim.',
    acceptObservation: acceptFileDialogs,
    acceptReport: acceptDialogsReport,
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
  'parent-close': {
    profile: PARENT_CLOSE_PROFILE,
    sourceSelectors: parentCloseSourceSelectors,
    fixture: 'examples/view-parent-close',
    browserEntry: null,
    directory: 'view-parent-close',
    title: 'View Parent Close',
    workloadLimitation:
      'One API parent-window close with four live native panes; OS quit, physical input and assistive technology remain separate qualification.',
    acceptObservation: acceptParentClose,
    acceptReport: acceptParentCloseReport,
  },
  commands: {
    profile: COMMANDS_PROFILE,
    sourceSelectors: commandsSourceSelectors,
    fixture: 'examples/window-commands',
    browserEntry: null,
    directory: 'window-commands',
    title: 'Window Commands',
    workloadLimitation:
      'Actual native popup and window-local shortcut callbacks driven by contributor-only synthetic native input; physical input, system menus and global shortcuts remain unqualified.',
    acceptObservation: acceptWindowCommands,
    acceptReport: acceptCommandsReport,
  },
} as const

export function desktopProfile(name = 'windows') {
  assert.ok(
    name === 'windows' ||
      name === 'composition' ||
      name === 'composition-profile' ||
      name === 'composition-interactions' ||
      name === 'services' ||
      name === 'downloads' ||
      name === 'parent-close' ||
      name === 'commands' ||
      name === 'status' ||
      name === 'links' ||
      name === 'dialogs',
    'Unknown desktop qualification case'
  )
  return profiles[name]
}

export function desktopReportProfile(profile: unknown) {
  if (profile === LEGACY_COMPOSITION_INTERACTIONS_PROFILE)
    return {
      ...profiles['composition-interactions'],
      profile: LEGACY_COMPOSITION_INTERACTIONS_PROFILE,
      workloadLimitation:
        'Historical v1 interaction evidence observes renderer state after RPC startup; initial exposure and temporary focus loss before that observation were not qualified.',
      acceptObservation: acceptCompositionInteractionsV1,
      acceptReport: acceptCompositionInteractionReportV1,
    }
  const selected = Object.values(profiles).find((entry) => entry.profile === profile)
  assert.ok(selected, 'Unknown desktop report profile')
  return selected
}

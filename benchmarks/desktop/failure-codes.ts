import { nativeEvents } from '../lib/cef-acceptance.ts'
import { summarizeNativeHostFailures } from '../lib/native-failure-codes.ts'
import type { CommandObservation } from '../lib/observed-command.ts'

// Literal inventories keep this helper portable to a branch without every
// desktop fixture. None of the optional fixture modules is imported or run.
const fixtures = {
  commands: {
    profile: 'native-window-commands-v1',
    event: 'bunly.native.window-commands',
    phases: [
      'ready',
      'policy',
      'shortcut',
      'selected-menu',
      'cancelled-menu',
      'dispose-open-menu',
      'abort-owner',
      'stale-document',
      'native-cleanup',
      'quit',
      'cleanup',
      'sdk-cleanup',
      'workload-deadline',
    ],
  },
  dialogs: {
    profile: 'native-file-dialogs-v1',
    event: 'bunly.native.file-dialogs',
    phases: [
      'setup',
      'capability',
      'open-cancel',
      'save-cancel',
      'managed-retirement',
      'navigation',
      'view-close',
      'quit',
      'managed-cleanup',
      'native-cleanup',
      'directory-cleanup',
      'shutdown-receipt',
      'shutdown-mismatch',
    ],
  },
  downloads: {
    profile: 'native-file-downloads-v1',
    event: 'bunly.native.file-downloads',
    phases: [
      'complete',
      'explicit-replace-large',
      'allowed-redirect',
      'denied-redirect',
      'cancel',
      'abort',
      'unknown-size-limit',
      'transfer-timeout',
      'network-interruption',
      'navigation-cancel',
      'renderer-reload-cancel',
      'view-close-cancel',
      'window-close-cancel',
      'quit-cancel',
      'setup',
      'native-shutdown',
      'quit-settlement',
      'sentinel-preservation',
      'fixture-server-shutdown',
      'temporary-root-cleanup',
      'workload-deadline',
    ],
  },
} as const
export type DesktopFailureFixture = keyof typeof fixtures
const names = [
  'Error',
  'AssertionError',
  'BunlyError',
  'TypeError',
  'RangeError',
  'AbortError',
] as const
const codes = [
  'INVALID_ARGUMENT',
  'INVALID_HANDLE',
  'DISPOSED',
  'RESOURCE_IN_USE',
  'UNSUPPORTED_CAPABILITY',
  'VERSION_MISMATCH',
  'PERMISSION_DENIED',
  'ERR_ASSERTION',
] as const
const errorCategories = {
  'Unknown or mismatched native download operation': 'native-identity',
  'Invalid native download progress': 'native-progress',
  'Invalid native download state transition': 'native-transition',
  'Invalid native download outcome': 'native-outcome',
  'Native download outcome does not match terminal progress': 'native-outcome-mismatch',
  'Invalid native download admission': 'native-admission',
  'Invalid native download cancellation receipt': 'native-cancellation',
  'File download fixture deadline': 'workload-deadline',
  'Download host closed before fixture completion': 'host-closed',
  'Native progress receipt capacity exceeded': 'progress-capacity',
  'Transfer settled before positive native progress': 'no-positive-progress',
  'Window commands qualification deadline': 'workload-deadline',
  'Command owner activation deadline': 'activation-deadline',
  'Command owner window closed': 'owner-closed',
  'Command document deadline': 'document-deadline',
  'Unexpected native close': 'host-closed',
  'Native command host failed': 'host-failed',
  'Window command observations aborted': 'observations-aborted',
  'Window command observation capacity': 'observation-capacity',
  'Concurrent window command observation waiter': 'observation-concurrent',
  'Unexpected native window command observation order': 'observation-order',
  'Unexpected unconsumed native window command observations': 'observation-unconsumed',
  'Window command observations closed': 'observations-closed',
  'Malformed native window command creation receipt': 'native-creation',
  'Malformed native menu admission receipt': 'native-admission',
  'Malformed native menu cancellation receipt': 'native-cancellation',
  'Malformed native window command disposal receipt': 'native-disposal',
  'Malformed native window command event': 'native-event',
  'Invalid native window command event identity or order': 'native-event-identity',
  'Invalid native command callback': 'native-callback',
  'Native menu command preceded visibility': 'menu-before-visible',
  'Malformed native popup event': 'native-popup',
  'Duplicate native menu visibility event': 'duplicate-visibility',
  'Unknown native window command event': 'unknown-native-event',
  'Malformed native window command qualification receipt': 'qualification-receipt',
  'File dialog fixture deadline': 'workload-deadline',
  'Host closed before dialog fixture completed': 'host-closed',
  'Invalid native dialog admission': 'native-admission',
  'Invalid native dialog cancellation receipt': 'native-cancellation',
  'Mismatched native dialog completion': 'native-identity',
  'Malformed native file dialog result': 'native-result',
  'Native file dialog failed': 'native-failure',
  MANAGED_DOCUMENT_CHANGED: 'document-changed',
  MANAGED_DOCUMENT_CLOSED: 'document-closed',
  MANAGED_DOCUMENT_RECEIPT_CAPACITY: 'document-capacity',
  MANAGED_DOCUMENT_ALREADY_BOUND: 'document-bound',
  MANAGED_DOCUMENT_CANCELLED: 'document-cancelled',
} as const
const categories = [...new Set(['unclassified', 'assertion', ...Object.values(errorCategories)])]

export interface DesktopFixtureFailure {
  readonly phase: string
  readonly name: (typeof names)[number] | 'unclassified'
  readonly code: (typeof codes)[number] | null
  readonly category: string
}
const unknownFailure: DesktopFixtureFailure = Object.freeze({
  phase: 'unknown-phase',
  name: 'unclassified',
  code: null,
  category: 'unclassified',
})
function phase(fixture: DesktopFailureFixture, value: unknown): string | undefined {
  return value === 'unknown-phase'
    ? 'unknown-phase'
    : fixtures[fixture].phases.find((candidate) => candidate === value)
}

/** Decode only complete literals whose every component belongs to a fixed inventory. */
export function classifyDesktopFixtureFailure(
  fixture: DesktopFailureFixture,
  failure: unknown
): DesktopFixtureFailure {
  if (typeof failure !== 'string' || failure.length > 256) return unknownFailure
  const legacyPhase = phase(fixture, failure)
  if (legacyPhase) return { ...unknownFailure, phase: legacyPhase }
  const match =
    /^([a-z][a-z-]{0,47}): ([A-Za-z]{1,32})(?: \(([A-Z][A-Z0-9_]{0,47})\))?(?: \[([a-z][a-z-]{0,63})\])?$/.exec(
      failure
    )
  if (!match) return unknownFailure
  const selectedPhase = phase(fixture, match[1])
  const name = names.find((candidate) => candidate === match[2])
  const code = match[3] === undefined ? null : codes.find((candidate) => candidate === match[3])
  const category =
    match[4] === undefined ? 'unclassified' : categories.find((candidate) => candidate === match[4])
  if (!selectedPhase || !name || code === undefined || !category) return unknownFailure
  return { phase: selectedPhase, name, code, category }
}

/** Exact known messages become fixed labels; error text, stack and cause never enter the result. */
export function formatDesktopFixtureFailure(
  fixture: DesktopFailureFixture,
  currentPhase: string,
  error: unknown
): string {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const name = names.find((candidate) => candidate === value['name']) ?? 'Error'
  const code = codes.find((candidate) => candidate === value['code'])
  const message = value['message']
  const category =
    typeof message === 'string' && Object.hasOwn(errorCategories, message)
      ? errorCategories[message as keyof typeof errorCategories]
      : name === 'AssertionError'
        ? 'assertion'
        : 'unclassified'
  return `${phase(fixture, currentPhase) ?? 'unknown-phase'}: ${name}${code ? ` (${code})` : ''} [${category}]`
}

/** Diagnostic only: never changes acceptance or reads a retained report. */
export function summarizeDesktopFailures(profile: string, observation?: CommandObservation) {
  const empty = { nativeFailures: [], fixtureFailures: [] } as const
  if (!observation) return { status: 'not-observed', ...empty } as const
  try {
    const events = nativeEvents(observation)
    const nativeFailures = summarizeNativeHostFailures(events)
    const fixture = (Object.keys(fixtures) as DesktopFailureFixture[]).find(
      (name) => fixtures[name].profile === profile
    )
    const fixtureFailures =
      fixture === undefined
        ? []
        : events
            .filter((event) => event['event'] === fixtures[fixture].event)
            .map((event) => ({
              fixture,
              passed: event['passed'] === true && event['failure'] === null,
              failure:
                event['passed'] === true && event['failure'] === null
                  ? null
                  : classifyDesktopFixtureFailure(fixture, event['failure']),
            }))
    return { status: 'observed', nativeFailures, fixtureFailures } as const
  } catch {
    return { status: 'unavailable', ...empty } as const
  }
}

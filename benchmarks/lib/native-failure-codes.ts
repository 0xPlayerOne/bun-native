/** Fixed source labels only. This diagnostic has no file, process or network access. */
const failureCodes = {
  'Native identity exhausted': 'native-identity-exhausted',
  'Native command admission unavailable': 'native-command-admission-unavailable',
  'CEF command dispatch unavailable': 'cef-command-dispatch-unavailable',
  'Native shutdown acknowledgement deadline exceeded': 'native-shutdown-deadline',
  'Session initialization completion could not be scheduled': 'session-initialization-dispatch',
  'Session initialization identity mismatch': 'session-initialization-identity',
  'Cookie store unavailable during session disposal': 'session-disposal-cookie-store',
  'Cookie store flush could not be scheduled': 'session-disposal-cookie-flush',
  'CEF initialized on incorrect thread': 'cef-initialization-thread',
  'Cookie enumeration completion could not be scheduled': 'cookie-enumeration-dispatch',
  'Native view overlay attachment failed': 'view-overlay-attachment',
  'Renderer process terminated before native shutdown': 'renderer-terminated',
  'Unable to reject resource redirect': 'resource-redirect-rejection',
  'Application event queue unavailable or full': 'application-event-queue',
  'Bun backend process exited before native shutdown': 'backend-supervised-early-exit',
  'Bun process exit supervision failed': 'backend-exit-supervision',
  'Bun input closed': 'backend-input-closed',
  'Bun backend exited before native shutdown': 'backend-pipe-early-exit',
  'Malformed or excessive application protocol output': 'application-protocol-framing',
  'Application stdout must contain protocol frames only': 'application-protocol-json',
  'Invalid protocol version or request sequence': 'application-protocol-sequence',
  'Bun startup handshake deadline exceeded': 'backend-handshake-deadline',
  'Duplicate Bun handshake': 'backend-handshake-duplicate',
  'First application request must be the Bun handshake': 'backend-handshake-order',
  'Invalid Bun handshake arguments': 'backend-handshake-arguments',
  'Packaged Bun version mismatch': 'backend-handshake-version',
  'Credential proof read could not be scheduled': 'credential-proof-read-dispatch',
  'Credential enumeration completion could not be scheduled': 'credential-enumeration-dispatch',
  'Credential proof completion could not be scheduled': 'credential-proof-dispatch',
  'Credential context retirement could not be scheduled': 'credential-retirement-dispatch',
  'Credential context release unavailable': 'credential-context-release',
  'Credential IO retirement fence unavailable': 'credential-io-fence',
  'Credential UI retirement fence unavailable': 'credential-ui-fence',
  'INVALID_HANDLE: view': 'view-handle-unavailable',
  'INVALID_HANDLE: owner window': 'view-window-unavailable',
  'View is closing': 'view-closing',
  'Window not ready': 'view-window-not-ready',
  'Browser view not ready': 'view-not-ready',
  'UNSUPPORTED_CAPABILITY: view.composition': 'view-composition-unavailable',
  'View placement not ready': 'view-placement-not-ready',
  'View overlay unavailable': 'view-overlay-unavailable',
  'Native focus could not leave an ineligible pane': 'view-focus-eviction',
  'Menu qualification input unavailable': 'menu-input-unavailable',
  'Menu input requires the native main thread': 'menu-input-main-thread',
  'Menu owner view unavailable': 'menu-owner-view-unavailable',
  'Menu owner window unavailable': 'menu-owner-window-unavailable',
  'Menu input requires the active visible owner window': 'menu-owner-not-active-visible',
  'Menu owner window number unavailable': 'menu-owner-window-number-unavailable',
  'Menu input event construction failed': 'menu-input-event-construction',
} as const

export type NativeFailureCode = (typeof failureCodes)[keyof typeof failureCodes] | 'unclassified'

/** Exact equality only: no prefix matching, trimming, interpolation or raw-error fallback. */
export function classifyNativeHostFailure(message: unknown): NativeFailureCode {
  return typeof message === 'string' && Object.hasOwn(failureCodes, message)
    ? failureCodes[message as keyof typeof failureCodes]
    : 'unclassified'
}

type ShutdownPhase =
  | 'no-phase-start-observed'
  | 'process-stop'
  | 'host-release'
  | 'asset-service-stop'
  | 'cef-shutdown'
  | 'unclassified-phase'

const ownerFields = [
  'windows',
  'windowsClosing',
  'views',
  'viewsClosing',
  'viewsCreating',
  'browserReferences',
  'browserViewReferences',
  'overlayReferences',
  'sessions',
  'sessionsBusy',
  'sessionsCreating',
  'sessionsDisposing',
] as const
const callbackFields = [
  'finalizeSessions',
  'finishLoop',
  'ioFence',
  'uiFence',
  'windowDestroyed',
  'browserBeforeClose',
  'flushRequested',
  'flushCompleted',
  'connectionsCloseRequested',
  'connectionsClosed',
] as const
type NativeShutdownPending =
  | { readonly status: 'unclassified' }
  | { readonly status: 'state-unavailable' }
  | {
      readonly status: 'observed'
      readonly schema: 1
      readonly stateAvailable: true
      readonly quitting: boolean
      readonly finalizing: boolean
      readonly saturated: boolean
      readonly credentialRetirementPending: boolean
      readonly owners: Readonly<Record<(typeof ownerFields)[number], number>>
      readonly callbacks: Readonly<Record<(typeof callbackFields)[number], number>>
    }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function fixedCounts<T extends string>(
  input: unknown,
  fields: readonly T[]
): Record<T, number> | undefined {
  const value = object(input)
  if (
    !value ||
    fields.some((field) => {
      const count = value[field]
      return typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 65_535
    })
  )
    return undefined
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as Record<T, number>
}
function shutdownPending(input: unknown): NativeShutdownPending {
  const value = object(input)
  if (value?.['schema'] === 1 && value['stateAvailable'] === false)
    return { status: 'state-unavailable' }
  const owners = fixedCounts(value?.['owners'], ownerFields)
  const callbacks = fixedCounts(value?.['callbacks'], callbackFields)
  if (
    !value ||
    value['schema'] !== 1 ||
    value['stateAvailable'] !== true ||
    typeof value['quitting'] !== 'boolean' ||
    typeof value['finalizing'] !== 'boolean' ||
    typeof value['saturated'] !== 'boolean' ||
    typeof value['credentialRetirementPending'] !== 'boolean' ||
    !owners ||
    !callbacks ||
    value['saturated'] !== [...Object.values(owners), ...Object.values(callbacks)].includes(65_535)
  )
    return { status: 'unclassified' }
  return {
    status: 'observed',
    schema: 1,
    stateAvailable: true,
    quitting: value['quitting'],
    finalizing: value['finalizing'],
    saturated: value['saturated'],
    credentialRetirementPending: value['credentialRetirementPending'],
    owners,
    callbacks,
  }
}

export interface NativeFailureReceipt {
  readonly code: NativeFailureCode
  /** Last observed phase start, not proof that earlier native close callbacks completed. */
  readonly phase: ShutdownPhase
  readonly pending?: NativeShutdownPending
}

/** For a fresh observed command's nativeEvents only; not an acceptance validator.
 * Preserve repeated failures in event order. Never return message text, paths,
 * application payloads, arbitrary phase names, or any other input property.
 */
export function summarizeNativeHostFailures(
  events: readonly Record<string, unknown>[]
): readonly NativeFailureReceipt[] {
  // Native receipts (128) plus the existing bounded stdout tail (40).
  if (events.length > 168) throw new Error('Native failure event budget exceeded')
  const failures: NativeFailureReceipt[] = []
  let phase: ShutdownPhase = 'no-phase-start-observed'
  for (const event of events) {
    if (event['event'] === 'bunly.host.shutdown-phase' && event['state'] === 'start') {
      switch (event['phase']) {
        case 'process-stop':
        case 'host-release':
        case 'asset-service-stop':
        case 'cef-shutdown':
          phase = event['phase']
          break
        default:
          phase = 'unclassified-phase'
      }
    }
    if (event['event'] === 'bunly.host.failure') {
      const code = classifyNativeHostFailure(event['error'])
      const pending =
        code === 'native-shutdown-deadline' && Object.hasOwn(event, 'pending')
          ? { pending: shutdownPending(event['pending']) }
          : {}
      failures.push({ code, phase, ...pending })
    }
  }
  return failures
}

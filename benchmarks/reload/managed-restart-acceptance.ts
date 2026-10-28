/** Separate controlled full-relaunch acceptance; no preserved-state timing is inferred. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { RESTART_DEADLINE_MS } from '../../examples/managed-desktop/restart-contract.ts'
import { reloadObservationResources } from './acceptance.ts'
import { acceptManagedNativeExit, managedObservationContentSha256 } from './managed-observation.ts'

export const MANAGED_RESTART_PROFILE = 'native-managed-restart-v1'
export const MANAGED_RESTART_OBSERVER_MS = 30_000
export const MANAGED_RESTART_CONFIGURATION = '{"changedNativeConfiguration":true}\n'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const record = (value: unknown, context: string): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), context)
  return value as Record<string, unknown>
}
const text = (value: unknown, context: string): string => {
  assert.ok(
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0'),
    context
  )
  return value
}
const zero = (value: Record<string, unknown>, fields: readonly string[]): void => {
  for (const field of fields) assert.equal(value[field], 0, `Restart retained ${field}`)
}
export interface ManagedRestartContext {
  readonly previousIdentities: Readonly<Record<string, string>>
  readonly previousRendererInstance: string
  readonly configurationSha256: string
}

export function acceptManagedRestartWorkload(
  observationInput: unknown,
  resultText: unknown,
  context: ManagedRestartContext
) {
  const { observation, events, backendExit, shutdown } = acceptManagedNativeExit(observationInput)
  assert.equal(
    events.some((event) => event['event'] === 'bunly.managed-development'),
    false,
    'Full restart requires a separate launch after the fixed soak'
  )
  assert.ok(
    typeof resultText === 'string' &&
      Buffer.byteLength(resultText) > 0 &&
      Buffer.byteLength(resultText) <= 256 * 1024,
    'Missing bounded controlled-restart result'
  )
  const result = record(JSON.parse(resultText), 'Missing restart result')
  assert.equal(result['event'], 'bunly.managed-restart')
  assert.equal(result['schema'], 1)
  assert.equal(result['passed'], true)
  assert.equal(result['failureCode'], undefined)
  assert.equal(
    context.configurationSha256,
    hash(MANAGED_RESTART_CONFIGURATION),
    'Full relaunch did not receive the exact changed configuration'
  )
  const backend = record(result['backend'], 'Missing freshly admitted backend result')
  assert.equal(backend['revision'], 500)
  assert.equal(backend['shared'], 1)
  assert.equal(backend['configurationApplied'], true)
  assert.equal(backend['configurationSha256'], context.configurationSha256)
  assert.equal(
    backend['loginAbsent'],
    true,
    'Ephemeral native cookie state survived full process replacement'
  )
  const renderer = record(result['renderer'], 'Missing fresh renderer receipt')
  const instance = text(renderer['instance'], 'Missing new browser instance')
  assert.notEqual(
    instance,
    text(context.previousRendererInstance, 'Missing previous browser instance'),
    'Full restart reused the old browser instance'
  )
  for (const field of ['formEmpty', 'sessionAbsent', 'loginAbsent', 'configurationApplied'])
    assert.equal(renderer[field], true)
  assert.equal(renderer['revision'], 500)
  assert.equal(renderer['shared'], 1)
  assert.equal(renderer['configurationSha256'], context.configurationSha256)
  const identities = record(result['identities'], 'Missing newly created native resources')
  assert.deepEqual(
    Object.keys(identities).sort(),
    ['window', 'view', 'session', 'document', 'url'].sort()
  )
  for (const field of ['window', 'view', 'session'])
    assert.notEqual(
      text(identities[field], 'Missing new native handle'),
      text(context.previousIdentities[field], 'Missing previous native handle'),
      `Full restart reused the old ${field} handle`
    )
  assert.equal(identities['url'], 'app://ui/restart.html')
  assert.equal(backend['url'], identities['url'])
  assert.equal(backend['session'], identities['session'])
  assert.equal(backend['document'], text(identities['document'], 'Missing native document context'))
  // Native document IDs are process-local counters and can repeat. Freshness is
  // established by separately observed launches and new public/browser UUIDs.
  const requests = record(result['requests'], 'Missing restart RPC accounting')
  assert.equal(requests['accepted'], 2)
  assert.equal(requests['settled'], 2)
  assert.equal(requests['pending'], 0)
  const final = record(result['final'], 'Missing restart cleanup')
  assert.equal(final['nativeSnapshotPhase'], 'before-last-window-close')
  const owner = record(final['owner'], 'Missing owner cleanup')
  assert.equal(owner['closed'], true)
  zero(owner, [
    'resources',
    'attachments',
    'generations',
    'work',
    'active',
    'candidate',
    'inFlight',
    'failedCleanup',
  ])
  const broker = record(final['broker'], 'Missing broker cleanup')
  assert.equal(broker['closed'], true)
  assert.equal(broker['active'], null)
  assert.equal(broker['candidate'], null)
  zero(broker, ['generations', 'requests', 'unsettledCallers', 'hostCalls', 'forcedTerminations'])
  const desktop = record(final['desktop'], 'Missing desktop cleanup')
  assert.equal(desktop['closed'], true)
  zero(desktop, ['resources', 'listener', 'queuedEvents', 'queuedEventBytes', 'eventOverflows'])
  const development = record(final['development'], 'Missing development cleanup')
  assert.equal(development['closed'], true)
  assert.equal(
    development['restartRequired'],
    false,
    'New development host did not adopt the changed configuration'
  )
  assert.equal(development['builds'], 1)
  assert.equal(development['replacements'], 1)
  zero(development, [
    'watchedDirectories',
    'dependencies',
    'pendingChanges',
    'pendingCallers',
    'retainedBundles',
  ])
  const native = record(final['native'], 'Missing native cleanup snapshot')
  assert.equal(native['windows'], 1)
  zero(native, [
    'views',
    'sessions',
    'pending',
    'nativeDeliveryPackets',
    'nativeDeliveryBytes',
    'rpcIncomingBytes',
    'streamIncomingBytes',
  ])
  const markers = events.filter((event) => event['event'] === 'bunly.managed-restart')
  assert.deepEqual(
    markers,
    [
      {
        event: 'bunly.managed-restart',
        schema: 1,
        passed: true,
        revision: 500,
        shared: 1,
        configurationApplied: true,
        failureCode: null,
      },
    ],
    'Exactly one matching restart marker must belong to the second observed launch'
  )
  assert.ok(events.indexOf(markers[0]!) < backendExit, 'Restart marker followed backend exit')
  return Object.freeze({
    profile: MANAGED_RESTART_PROFILE,
    launches: 1,
    admittedRevision: 500,
    admittedShared: 1,
    configurationSha256: context.configurationSha256,
    freshNativeHandles: true,
    freshRendererInstance: true,
    unsavedFormRestored: false,
    ephemeralSessionRestored: false,
    ephemeralLoginRestored: false,
    requestsAccepted: 2,
    requestsSettled: 2,
    processResources: reloadObservationResources(observation),
    nativeShutdownMs: shutdown,
    performanceEligible: false,
  })
}

export function acceptManagedRestartReport(input: unknown, context: ManagedRestartContext) {
  const report = record(input, 'Missing controlled-restart trial')
  assert.equal(report['schema'], 1)
  assert.equal(report['profile'], MANAGED_RESTART_PROFILE)
  assert.equal(report['attempted'], true)
  assert.equal(report['passed'], true)
  assert.equal(report['launches'], 1)
  assert.equal(report['observerTimeoutMs'], MANAGED_RESTART_OBSERVER_MS)
  assert.equal(report['fixtureDeadlineMs'], RESTART_DEADLINE_MS)
  assert.equal(report['configurationSha256'], context.configurationSha256)
  assert.equal(report['configurationUnchanged'], true)
  assert.equal(report['launchPathEmpty'], true)
  assert.equal(report['performanceEligible'], false)
  assert.match(String(report['observationSha256']), /^[a-f0-9]{64}$/)
  assert.equal(
    report['observationContentSha256'],
    managedObservationContentSha256(report['observation']),
    'Embedded restart observation differs from its retained digest'
  )
  const result = report['resultText']
  assert.equal(typeof result, 'string')
  assert.equal(report['resultBytes'], Buffer.byteLength(String(result)))
  assert.equal(report['resultSha256'], hash(String(result)))
  const acceptance = acceptManagedRestartWorkload(report['observation'], result, context)
  assert.deepEqual(report['acceptance'], acceptance)
  return acceptance
}

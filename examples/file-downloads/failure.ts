import { downloadFixtureSteps } from './contract.ts'

const phases = new Set<string>([
  ...downloadFixtureSteps,
  'setup',
  'native-shutdown',
  'quit-settlement',
  'sentinel-preservation',
  'fixture-server-shutdown',
  'temporary-root-cleanup',
])
const names = new Set([
  'Error',
  'AssertionError',
  'BunlyError',
  'TypeError',
  'RangeError',
  'AbortError',
])
const codes = new Set([
  'INVALID_ARGUMENT',
  'INVALID_HANDLE',
  'DISPOSED',
  'RESOURCE_IN_USE',
  'UNSUPPORTED_CAPABILITY',
  'VERSION_MISMATCH',
  'PERMISSION_DENIED',
  'ERR_ASSERTION',
])
const categories = new Map([
  ['Unknown or mismatched native download operation', 'native-identity'],
  ['Invalid native download progress', 'native-progress'],
  ['Invalid native download state transition', 'native-transition'],
  ['Invalid native download outcome', 'native-outcome'],
  ['Native download outcome does not match terminal progress', 'native-outcome-mismatch'],
  ['Invalid native download admission', 'native-admission'],
  ['Invalid native download cancellation receipt', 'native-cancellation'],
  ['File download fixture deadline', 'workload-deadline'],
  ['Download host closed before fixture completion', 'host-closed'],
  ['Native progress receipt capacity exceeded', 'progress-capacity'],
  ['Transfer settled before positive native progress', 'no-positive-progress'],
  ['Download directory requires an owned, explicit Windows DACL', 'windows-root-dacl'],
  ['Download directory must belong to the current user', 'windows-root-owner'],
  ['Download directory is writable by another user', 'windows-root-shared-writer'],
  ['Unsupported download directory ACL entry', 'windows-root-acl-entry'],
  ['Download roots require a local absolute drive path', 'windows-root-path'],
  ['Download volume must preserve Windows ACLs and security streams', 'windows-root-volume'],
  ['Access is denied. (os error 5)', 'windows-access-denied'],
  [
    'The process cannot access the file because it is being used by another process. (os error 32)',
    'windows-sharing-violation',
  ],
])

/** Only exact known errors become fixed labels; never export arbitrary error text or metadata. */
export function downloadFixtureFailure(phase: string, error: unknown): string {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const name =
    typeof value['name'] === 'string' && names.has(value['name']) ? value['name'] : 'Error'
  const code =
    typeof value['code'] === 'string' && codes.has(value['code']) ? ` (${value['code']})` : ''
  const category =
    typeof value['message'] === 'string' ? categories.get(value['message']) : undefined
  return `${phases.has(phase) ? phase : 'unknown-phase'}: ${name}${code} [${category ?? 'unclassified'}]`
}

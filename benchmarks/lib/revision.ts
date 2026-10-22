/** Correctness gates for edit benchmarks. Timing alone never proves an edit landed. */
export interface RevisionObservation {
  readonly revision: string
  readonly document: string
  readonly instance: string
  readonly generation: number
  readonly sequence: number
  readonly retainedInput: string
  readonly counter: number
}
export type EditMode = 'frontend-hmr' | 'backend-relaunch' | 'backend-preserving'
function bounded(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  )
    throw new Error(`Invalid ${name}`)
}
export function revisionObservation(input: unknown): RevisionObservation {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected revision observation')
  const value = input as Record<string, unknown>
  const fields = [
    'revision',
    'document',
    'instance',
    'generation',
    'sequence',
    'retainedInput',
    'counter',
  ]
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('Unexpected revision observation fields')
  for (const key of ['revision', 'document', 'instance']) bounded(value[key], key)
  for (const key of ['generation', 'sequence', 'counter']) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < (key === 'counter' ? 0 : 1))
      throw new Error(`Invalid ${key}`)
  }
  if (typeof value['retainedInput'] !== 'string' || value['retainedInput'].length > 4096)
    throw new Error('Invalid retained input')
  return Object.freeze({ ...value }) as unknown as RevisionObservation
}
export function assertEditApplied(
  beforeInput: unknown,
  afterInput: unknown,
  expectedRevision: string,
  mode: EditMode
): void {
  bounded(expectedRevision, 'expected revision')
  if (!['frontend-hmr', 'backend-relaunch', 'backend-preserving'].includes(mode))
    throw new Error('Unknown edit mode')
  const before = revisionObservation(beforeInput),
    after = revisionObservation(afterInput)
  if (expectedRevision === before.revision || after.revision !== expectedRevision)
    throw new Error('Expected changed revision was not applied')
  if (after.sequence <= before.sequence) throw new Error('Stale edit acknowledgement')
  if (after.counter !== before.counter || after.retainedInput !== before.retainedInput)
    throw new Error('Retained fixture state changed')
  if (mode === 'frontend-hmr') {
    if (after.document !== before.document || after.instance !== before.instance)
      throw new Error('HMR replaced the document or backend')
    if (after.generation <= before.generation) throw new Error('Frontend module was not replaced')
  } else if (mode === 'backend-relaunch') {
    if (after.instance === before.instance) throw new Error('Backend did not relaunch')
  } else {
    if (after.document !== before.document || after.instance === before.instance)
      throw new Error('Managed replacement identity mismatch')
  }
}
/** A broken revision must produce a new explicit diagnostic before repair starts. */
export function assertFailedEdit(
  beforeInput: unknown,
  currentInput: unknown,
  diagnostic: unknown
): void {
  const before = revisionObservation(beforeInput),
    current = revisionObservation(currentInput)
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic))
    throw new Error('Missing failed-edit diagnostic')
  const value = diagnostic as Record<string, unknown>
  if (
    Object.keys(value).length !== 3 ||
    value['kind'] !== 'compile-error' ||
    value['sequence'] !== current.sequence ||
    !Number.isSafeInteger(value['sequence']) ||
    Number(value['sequence']) <= before.sequence
  )
    throw new Error('Stale or invalid failed-edit diagnostic')
  bounded(value['attemptedRevision'], 'attempted revision')
  if (
    value['attemptedRevision'] === before.revision ||
    current.revision !== before.revision ||
    current.document !== before.document ||
    current.instance !== before.instance ||
    current.generation !== before.generation ||
    current.counter !== before.counter ||
    current.retainedInput !== before.retainedInput
  )
    throw new Error('Failed edit changed the last usable fixture')
}

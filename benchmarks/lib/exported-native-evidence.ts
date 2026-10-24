import { validateCommandObservation, type CommandObservation } from './observed-command.ts'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid exported native evidence')
  return value as Record<string, unknown>
}
/** Explicit projection for sanitized exports, never a live-observer identity. */
export function validateExportedCommandObservation(value: unknown): CommandObservation {
  const input = record(value)
  const marker = record(input['observationExport'])
  if (
    Object.keys(marker).sort().join(',') !== 'correlation,schema' ||
    marker['schema'] !== 1 ||
    !['omitted', 'absent'].includes(String(marker['correlation'])) ||
    Object.hasOwn(input, 'observationId')
  )
    throw new Error('Invalid exported observation correlation')
  const projected = { ...input }
  delete projected['observationExport']
  return validateCommandObservation(projected)
}
/** Decode only marked exports. All acceptance/cleanup validators still run on
 * projected observations; no private nonce or live correlation is reconstructed. */
export function decodeExportedNativeReport(value: unknown): Record<string, unknown> {
  const input = record(value)
  const marker = record(input['nativeEvidenceExport'])
  if (
    Object.keys(marker).sort().join(',') !== 'correlation,redactions,schema' ||
    marker['schema'] !== 1 ||
    marker['correlation'] !== 'not-retained' ||
    !Array.isArray(marker['redactions']) ||
    marker['redactions'].length !== 1 ||
    marker['redactions'][0] !== 'fixture-nonces'
  )
    throw new Error('Unknown native evidence export schema')
  let visited = 0
  function visit(item: unknown, depth: number): unknown {
    if (++visited > 2_000_000 || depth > 64)
      throw new Error('Exported native evidence exceeds bounds')
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1))
    if (!item || typeof item !== 'object') return item
    const entry = item as Record<string, unknown>
    if (entry['schema'] === 1 && 'exitCode' in entry && 'samples' in entry)
      return validateExportedCommandObservation(entry)
    return Object.fromEntries(
      Object.entries(entry).map(([key, child]) => [key, visit(child, depth + 1)])
    )
  }
  const result = visit(input, 0) as Record<string, unknown>
  delete result['nativeEvidenceExport']
  return result
}

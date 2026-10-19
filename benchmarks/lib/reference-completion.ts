/** Final collector gate. Nested application success cannot hide failed measurements. */
export function referenceTrialComplete(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const trial = value as Record<string, unknown>
  const result = trial['result'] as Record<string, unknown> | undefined
  const idle = trial['idle'] as Record<string, unknown> | undefined
  const kernel = idle?.['kernel'] as Record<string, unknown> | undefined
  return (
    trial['failed'] === undefined &&
    result?.['passed'] === true &&
    idle?.['observed'] === true &&
    kernel?.['status'] === 'observed' &&
    typeof idle['sampleCount'] === 'number' &&
    Number.isSafeInteger(idle['sampleCount']) &&
    idle['sampleCount'] >= 20 &&
    typeof idle['sampledDurationMs'] === 'number' &&
    Number.isFinite(idle['sampledDurationMs']) &&
    idle['sampledDurationMs'] >= 4500
  )
}

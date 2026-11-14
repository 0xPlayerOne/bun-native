/** Validate offline OCR evidence before accepting a captured visible label. */
type Box = readonly [number, number, number, number]
type Observation = { text: string; confidence: number; bounds: Box }
type Result = { size: [number, number]; recognitionMs: number; observations: Observation[] }

function box(value: unknown): value is Box {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return false
  const [x, y, width, height] = value as number[]
  return x! >= 0 && y! >= 0 && width! > 0 && height! > 0 && x! + width! <= 1 && y! + height! <= 1
}

/**
 * Bounds and region use normalized bottom-left coordinates, as reported by
 * Vision. Exactly one expected label must be wholly inside the calibrated
 * region, with no forbidden label in that region. Recognition is not proof
 * of window ownership or of physical display presentation.
 */
export function verifyVisibleText(
  value: unknown,
  expected: string,
  forbidden: string,
  region: Box,
  minimumConfidence = 0.5
): Result {
  if (!box(region) || !expected || !forbidden || expected === forbidden)
    throw new Error('Invalid calibrated text expectation')
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1)
    throw new Error('Invalid OCR confidence threshold')
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid OCR result')
  const result = value as Record<string, unknown>
  if (
    result['status'] !== 'passed' ||
    result['boundsOrigin'] !== 'normalized bottom-left' ||
    !Array.isArray(result['size']) ||
    result['size'].length !== 2 ||
    !result['size'].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 8192) ||
    typeof result['recognitionMs'] !== 'number' ||
    !Number.isFinite(result['recognitionMs']) ||
    result['recognitionMs'] < 0 ||
    !Array.isArray(result['observations']) ||
    result['observations'].length > 256
  )
    throw new Error('Invalid OCR result metadata')
  const observations: Observation[] = result['observations'].map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid OCR item')
    const entry = item as Record<string, unknown>
    if (
      typeof entry['text'] !== 'string' ||
      entry['text'].length > 512 ||
      typeof entry['confidence'] !== 'number' ||
      !Number.isFinite(entry['confidence']) ||
      entry['confidence'] < 0 ||
      entry['confidence'] > 1 ||
      !box(entry['bounds'])
    )
      throw new Error('Invalid OCR item')
    return { text: entry['text'], confidence: entry['confidence'], bounds: entry['bounds'] }
  })
  const [rx, ry, rw, rh] = region
  const inside = ({ bounds: [x, y, width, height] }: Observation) =>
    x >= rx && y >= ry && x + width <= rx + rw && y + height <= ry + rh
  const relevant = observations.filter(inside)
  const matches = relevant.filter((item) => item.text === expected)
  if (
    matches.length !== 1 ||
    matches[0]!.confidence < minimumConfidence ||
    relevant.some((item) => item.text === forbidden)
  )
    throw new Error('Captured text does not match the calibrated state')
  return {
    size: result['size'] as [number, number],
    recognitionMs: result['recognitionMs'],
    observations,
  }
}

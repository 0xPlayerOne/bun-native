export type Variant = 'reference' | 'native'
export type Trial = { phase: 'warmup' | 'control' | 'comparison'; pair: number; variant: Variant }

/** Prespecified order: fresh processes, both A/A controls, then alternating AB/BA. */
export function visiblePairsPlan(pairs: number): Trial[] {
  if (!Number.isSafeInteger(pairs) || pairs < 3 || pairs > 20)
    throw new Error('Visible comparison requires 3 to 20 pairs')
  const trials: Trial[] = [
    { phase: 'warmup', pair: 0, variant: 'reference' },
    { phase: 'warmup', pair: 0, variant: 'native' },
  ]
  for (let pair = 0; pair < 3; pair++) {
    const order: Variant[] = pair % 2 ? ['native', 'reference'] : ['reference', 'native']
    for (const variant of order)
      for (let repeat = 0; repeat < 2; repeat++) trials.push({ phase: 'control', pair, variant })
  }
  for (let pair = 0; pair < pairs; pair++) {
    const order: Variant[] = pair % 2 ? ['native', 'reference'] : ['reference', 'native']
    for (const variant of order) trials.push({ phase: 'comparison', pair, variant })
  }
  return trials
}

/** Deterministic reporting helpers. No framework or host dependency. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
export function quantile(values: readonly number[], probability: number): number {
  if (!values.length || values.some(value => !Number.isFinite(value)) || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid quantile input');
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const index = Math.floor(position);
  return sorted[index]! + (sorted[Math.min(index + 1, sorted.length - 1)]! - sorted[index]!) * (position - index);
}
export function summarize(values: readonly number[], seed = 1) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Expected non-negative finite samples');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  const rng = random(seed);
  const bootstrap = Array.from({ length: 1000 }, () => {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[Math.floor(rng() * values.length)]!;
    return total / values.length;
  });
  return { count: values.length, mean, median: quantile(values, 0.5), p95: quantile(values, 0.95), p99: quantile(values, 0.99),
    min: Math.min(...values), max: Math.max(...values), standardDeviation: Math.sqrt(variance),
    meanBootstrap95: values.length < 2 ? null : [quantile(bootstrap, 0.025), quantile(bootstrap, 0.975)],
    method: 'linear-interpolated quantiles; 1000 deterministic percentile-bootstrap mean resamples' };
}
export function schedule(variants: readonly string[], repetitions: number, seed: number): { variant: string; trial: number }[] {
  if (!variants.length || new Set(variants).size !== variants.length || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 1000) throw new Error('Invalid benchmark schedule');
  const rng = random(seed);
  const result: { variant: string; trial: number }[] = [];
  for (let trial = 0; trial < repetitions; trial++) {
    const order = [...variants];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    for (const variant of order) result.push({ variant, trial });
  }
  return result;
}

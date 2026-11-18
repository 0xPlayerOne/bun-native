/**
 * Whether an Electrobun run is a pass (#677).
 *
 * Medians are computed over the measured trials only, with the first launch
 * reported separately. That exclusion is about warm-up, not about evidence: a
 * first launch that failed still proves the app does not start reliably, so it
 * fails the run. Reporting a median over the survivors let a 13.7 s first-launch
 * failure read as a 1.98 s median.
 */
export type LaunchOutcome = { name: string; status: string }

export function runStatus(trials: number, launches: readonly LaunchOutcome[]): 'passed' | 'failed' {
  const measured = launches.filter((item) => item.name !== 'first')
  const passed = measured.filter((item) => item.status === 'passed')
  return launches[0]?.status === 'passed' && measured.length === trials && passed.length === trials
    ? 'passed'
    : 'failed'
}

/** A failed launch that must be named in the record, never silently dropped. */
export function failedLaunches(launches: readonly LaunchOutcome[]) {
  return launches.filter((item) => item.status !== 'passed').map((item) => item.name)
}

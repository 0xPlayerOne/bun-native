/** Acceptance of actual native-host reports, not a browser/security simulation. */
import { assertCleanCommand, type CommandObservation } from './observed-command.ts'
export function nativeEvents(report: CommandObservation): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const line of [...report.stdoutTail, ...report.stderr]) {
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value))
        result.push(value as Record<string, unknown>)
    } catch {
      /* Ordinary native diagnostic text is retained in the raw report. */
    }
  }
  return result
}
export function acceptNativeSmoke(report: CommandObservation): void {
  assertCleanCommand(report)
  const events = nativeEvents(report)
  const smoke = events.filter((event) => event['event'] === 'bunly.native.smoke')
  if (
    smoke.length !== 1 ||
    smoke[0]!['passed'] !== true ||
    smoke[0]!['cycles'] !== 20 ||
    !Number.isSafeInteger(smoke[0]!['timers']) ||
    Number(smoke[0]!['timers']) < 1
  )
    throw new Error('Native smoke did not execute the declared workload')
  const diagnostics = smoke[0]!['diagnostics'] as Record<string, unknown> | undefined
  if (
    !diagnostics ||
    diagnostics['windows'] !== 1 ||
    diagnostics['views'] !== 1 ||
    diagnostics['sessions'] !== 1
  )
    throw new Error('Native resource counts did not converge')
  if (
    !events.some(
      (event) =>
        event['event'] === 'bunly.backend.exit' && event['code'] === 0 && event['forced'] === false
    ) ||
    !events.some((event) => event['event'] === 'bunly.host.shutdown' && event['clean'] === true) ||
    events.some((event) => event['event'] === 'bunly.host.failure')
  )
    throw new Error('Native host or backend did not shut down cleanly')
}
export function acceptNativeRejection(report: CommandObservation, expected: string): void {
  assertCleanCommand(report, 78)
  if (
    !nativeEvents(report).some(
      (event) =>
        event['event'] === 'bunly.host.error' &&
        typeof event['error'] === 'string' &&
        event['error'].includes(expected)
    )
  )
    throw new Error('Native startup did not reject the specified invalid configuration')
}

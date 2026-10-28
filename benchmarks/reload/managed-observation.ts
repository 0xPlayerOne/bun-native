import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { assertCleanCommand, validateCommandObservation } from '../lib/observed-command.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'

/** The raw-file hash remains separate. This digest binds the embedded observation
 * across explicitly marked nonce-redacted exports without inventing live correlation. */
export function managedObservationContentSha256(input: unknown): string {
  const observation = validateCommandObservation(input)
  const source = { ...observation } as Record<string, unknown>
  delete source['observationId']
  let visited = 0
  function canonical(value: unknown, depth: number): unknown {
    assert.ok(
      ++visited <= 2_000_000 && depth <= 64,
      'Observation content exceeds bounded projection'
    )
    if (typeof value === 'string')
      return value.replace(/(?<![a-fA-F0-9])[a-fA-F0-9]{48}(?![a-fA-F0-9])/g, '[fixture-nonce]')
    if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1))
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child, depth + 1)])
      )
    return value
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(source, 0)))
    .digest('hex')
}

/** Shared ordinary native exit gates for the soak and separate controlled relaunch. */
export function acceptManagedNativeExit(input: unknown) {
  const observation = validateCommandObservation(input)
  assertCleanCommand(observation)
  const shutdown = requireNativeShutdown(observeNativeShutdown(observation))
  if (observation.environment['os'] === 'Darwin') {
    assert.equal(
      observation.postExitCleanup?.qualified,
      true,
      'macOS helper/clone cleanup must be positively qualified'
    )
    assert.equal(observation.postExitCleanup?.status, 'completed')
  }
  const events = nativeEvents(observation)
  const drain = events.filter((event) => event['event'] === 'bunly.native.output-drained')
  assert.deepEqual(
    drain,
    [
      {
        event: 'bunly.native.output-drained',
        schema: 1,
        frames: 0,
        ordinaryFrames: 0,
        retainedWireBytes: 0,
        ordinaryWireBytes: 0,
      },
    ],
    'Native output was not drained exactly once'
  )
  const backendExit = events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  assert.ok(backendExit >= 0 && backendExit < events.indexOf(drain[0]!))
  assert.ok(
    events.indexOf(drain[0]!) <
      events.findIndex(
        (event) =>
          event['event'] === 'bunly.host.shutdown-phase' &&
          event['phase'] === 'process-stop' &&
          event['state'] === 'complete'
      )
  )
  return { observation, events, backendExit, shutdown }
}

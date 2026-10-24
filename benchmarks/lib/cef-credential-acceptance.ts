import assert from 'node:assert/strict'
import { assertCleanCommand, type CommandObservation } from './observed-command.ts'
import { nativeEvents } from './cef-acceptance.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
export const credentialModes = [
  'seed',
  'present',
  'clear',
  'cleared',
  'unavailable',
  'intent-denied',
] as const
export type CredentialMode = (typeof credentialModes)[number]
export function acceptNativeCredentials(
  observation: CommandObservation,
  mode: CredentialMode
): void {
  assert.ok(credentialModes.includes(mode), 'Unknown credential fixture mode')
  assertCleanCommand(observation)
  requireNativeShutdown(observeNativeShutdown(observation))
  const admitted = mode !== 'unavailable' && mode !== 'intent-denied'
  assert.deepEqual(
    nativeEvents(observation).filter((event) => event['event'] === 'bunly.native.credentials'),
    [
      {
        event: 'bunly.native.credentials',
        schema: 1,
        mode,
        passed: true,
        admitted,
        browserChecks: admitted ? 3 : 0,
        applicationSessions: 0,
      },
    ]
  )
}

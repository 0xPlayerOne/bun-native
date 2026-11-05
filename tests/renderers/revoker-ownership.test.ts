import { expect, test } from 'bun:test'
import { observeScenario } from './collectability.ts'

/** Real headless IPC in a DFG-disabled child; see collectability-scenarios.ts. */
test('retained window unsubscribe handles release their callbacks immediately', async () => {
  expect((await observeScenario('revoked-callbacks')).survivors).toEqual([])
})

test('window completion releases callbacks even while unsubscribe handles stay live', async () => {
  expect((await observeScenario('completed-callbacks')).survivors).toEqual([])
})

test('an unreleased subscription stays observable after every round (negative control)', async () => {
  expect(await observeScenario('unreleased-callback-control')).toEqual({
    survivors: [6],
    rounds: 2,
    maxRounds: 2,
  })
})

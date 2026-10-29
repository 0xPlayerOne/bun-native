import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { removeSessionResetFixture } from './helpers/remove-session-reset-fixture.ts'

const failure = (code: string) => Object.assign(new Error(code), { code })

test('fixture cleanup retries documented transient errors with the existing linear budget', async () => {
  const waits: number[] = []
  let attempts = 0
  await removeSessionResetFixture(
    'fixture',
    async () => {
      attempts++
      if (attempts <= 5)
        throw failure(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'][attempts - 1]!)
    },
    async (delay) => {
      waits.push(delay)
    }
  )
  assert.equal(attempts, 6)
  assert.deepEqual(waits, [25, 50, 75, 100, 125])
})

test('fixture cleanup propagates persistent or nontransient errors', async () => {
  for (const [code, expectedAttempts] of [
    ['EBUSY', 6],
    ['EACCES', 1],
  ] as const) {
    const error = failure(code)
    let attempts = 0
    const waits: number[] = []
    await assert.rejects(
      removeSessionResetFixture(
        'fixture',
        async () => {
          attempts++
          throw error
        },
        async (delay) => {
          waits.push(delay)
        }
      ),
      (received) => received === error
    )
    assert.equal(attempts, expectedAttempts)
    assert.equal(waits.length, expectedAttempts - 1)
  }
})

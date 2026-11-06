import { describe } from 'bun:test'
import { remountTest, useReloadFixture } from './reload-fixture.ts'

useReloadFixture()

describe('development remounts (real Bun processes and headless protocol peer, no GPUI)', () => {
  remountTest('solid')
})

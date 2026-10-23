import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../examples/cef/public/hostile.js', import.meta.url), 'utf8')

test('borrow diagnostic distinguishes a normal JS return, exact context denial and unrelated errors', () => {
  // Test the fixture's reporting, not native CEF isolation.
  for (const [reason, expected] of [
    [null, 'returned-without-exception'],
    ['RPC function belongs to another document context', 'denied'],
    ['RPC document authority was revoked', 'unexpected-error'],
    ['RPC packet already pending or context replaced', 'unexpected-error'],
    ['x'.repeat(1000), 'unexpected-error'],
  ] as const) {
    const fixture: Record<string, unknown> = {
      parent: {
        __bunlyRpc: {
          send() {
            if (reason !== null) throw new Error(reason)
          },
        },
      },
    }
    runInNewContext(source, fixture, { timeout: 1000 })
    assert.equal(fixture['hostileFixtureRan'], true)
    assert.equal(fixture['bridgePresent'], false)
    assert.equal(fixture['borrowedBridge'], expected)
    if (reason === null) assert.equal(fixture['borrowedError'], null)
    else assert.equal(fixture['borrowedError'], ('Error: ' + reason).slice(0, 256))
  }
})

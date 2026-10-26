import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import loadFixture from '../../examples/cef-terminal-load/fixture.ts'
import type { CefBackend } from '../../packages/runtime/src/cef.ts'

const output = process.argv[2]!
process.env['BUNLY_TERMINAL_LOAD_MODE'] = 'visible'
process.env['BUNLY_TERMINAL_LOAD_OUTPUT'] = output
const denied = new Error('fixed-native-owner-unavailable')
let calls = 0
const backend = {
  async createTerminalDriver(options: unknown) {
    assert.deepEqual(options, { profile: 'non-detaching' })
    calls++
    throw denied
  },
} as unknown as CefBackend
await assert.rejects(loadFixture(backend), (error) => error === denied)
assert.equal(calls, 1, 'Native owner selection is mandatory, never direct-child fallback')
await assert.rejects(access(output), { code: 'ENOENT' })
console.log('native-owner-selection-required-before-fixture-admission')

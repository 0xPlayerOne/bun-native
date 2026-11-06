import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FrameDecoder, parseCommand, parseEvent, PROTOCOL_VERSION } from '@bun-native/protocol'

/**
 * Shared with native/protocol/tests/conformance.rs. `expect` is the contract;
 * a case with `knownDivergence` names the side that currently does the
 * opposite, and both suites assert that divergence explicitly.
 */
interface Case {
  name: string
  category: string
  direction: 'command' | 'event'
  frame: string
  expect: 'accept' | 'reject'
  knownDivergence?: string
  divergentSide?: 'rust' | 'typescript'
}

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'protocol-conformance.json'), 'utf8')
) as { protocol: number; scope: string; cases: Case[] }

function outcome(entry: Case): 'accept' | 'reject' {
  try {
    const values = new FrameDecoder().push(new TextEncoder().encode(`${entry.frame}\n`))
    if (values.length !== 1) return 'reject'
    if (entry.direction === 'command') parseCommand(values[0])
    else parseEvent(values[0])
    return 'accept'
  } catch {
    return 'reject'
  }
}

const flip = (value: Case['expect']) => (value === 'accept' ? 'reject' : 'accept')

test('conformance fixtures target the implemented protocol and are well formed', () => {
  expect(fixtures.protocol).toBe(PROTOCOL_VERSION)
  expect(fixtures.scope).not.toBe('')
  expect(new Set(fixtures.cases.map((entry) => entry.name)).size).toBe(fixtures.cases.length)
  for (const entry of fixtures.cases) {
    expect(['command', 'event']).toContain(entry.direction)
    expect(['accept', 'reject']).toContain(entry.expect)
    expect(entry.category).not.toBe('')
    expect('knownDivergence' in entry).toBe('divergentSide' in entry)
    if (entry.knownDivergence !== undefined) {
      expect(entry.knownDivergence).not.toBe('')
      expect(['rust', 'typescript']).toContain(entry.divergentSide ?? '')
    }
  }
})

for (const entry of fixtures.cases) {
  test(`conformance ${entry.direction}: ${entry.name}`, () => {
    const expected = entry.divergentSide === 'typescript' ? flip(entry.expect) : entry.expect
    expect(outcome(entry)).toBe(expected)
  })
}

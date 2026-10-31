import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectBunExecutable } from './inspect'

const directory = mkdtempSync(join(tmpdir(), 'bun-native-inspect-test-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

// A minimal synthetic metadata envelope tests parser bounds only. The integration
// runner separately inspects and executes actual AOT and JIT compiler outputs.
function envelope(flags = 0x4000): Buffer {
  const bytes = Buffer.alloc(172)
  bytes.writeUInt32LE(0x464c457f, 0)
  bytes.writeBigUInt64LE(112n, 52)
  bytes.writeBigUInt64LE(64n, 124)
  bytes.writeUInt32LE(0, 132)
  bytes.writeUInt32LE(52, 136)
  bytes.writeUInt32LE(0, 140)
  bytes.writeUInt32LE(63, 144)
  bytes.writeUInt32LE(0, 148)
  bytes.writeUInt32LE(flags, 152)
  bytes.write('\n---- Bun! ----\n', 156)
  return bytes
}

function inspect(bytes: Buffer) {
  const file = join(directory, 'fixture')
  writeFileSync(file, bytes)
  return inspectBunExecutable(file)
}

test('distinguishes compiled-program metadata from a JIT graph', () => {
  expect(inspect(envelope()).hasCompiledProgram).toBe(true)
  expect(inspect(envelope(0)).hasCompiledProgram).toBe(false)
})

test('rejects non-executables and a missing or truncated envelope', () => {
  expect(() => inspect(Buffer.from('not an executable'))).toThrow('Unsupported executable format')
  expect(() => inspect(envelope().subarray(0, 160))).toThrow('No valid pinned Bun')
  expect(() => inspect(envelope().subarray(0, 4))).toThrow('No valid pinned Bun')
})

test('rejects a count beyond the file before converting it to a Number', () => {
  const bytes = envelope()
  bytes.writeBigUInt64LE(0xffffffffffffffffn, 124)
  expect(() => inspect(bytes)).toThrow('No valid pinned Bun')
})

test.each([
  ['header length', 52, 999],
  ['module offset', 132, 65],
  ['partial module record', 136, 51],
  ['entry point outside table', 140, 1],
  ['argv offset', 144, 65],
  ['argv length', 148, 2],
  ['unknown flags', 152, 0x8000],
] as const)('rejects an invalid %s', (_name, offset, value) => {
  const bytes = envelope()
  bytes.writeUInt32LE(value, offset)
  expect(() => inspect(bytes)).toThrow('No valid pinned Bun')
})

test('ignores a trailing marker that has no valid length and bounds', () => {
  const bytes = Buffer.concat([envelope(), Buffer.alloc(40), Buffer.from('\n---- Bun! ----\n')])
  expect(inspect(bytes).hasCompiledProgram).toBe(true)
})

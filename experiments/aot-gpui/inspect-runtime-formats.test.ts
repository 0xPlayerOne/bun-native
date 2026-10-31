import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectBunRuntime } from './inspect-runtime'

const directory = mkdtempSync(join(tmpdir(), 'bun-native-format-inspect-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

// Synthetic metadata exercises parsing only. Hosted integration must compile,
// inspect and execute real AOT and JIT controls on each claimed target platform.
function state(bytes: Buffer, offset: number, range: number, relative: bigint) {
  bytes.write('BUNFEAT\0', offset)
  bytes.writeUInt32LE(1, offset + 12)
  bytes.writeBigInt64LE(relative, offset + 16)
  bytes[offset + 24] = 1
  bytes[offset + 27] = 1
  bytes.writeBigInt64LE(0x2000n, range)
  bytes.writeUInt32LE(16, range + 8)
}

function macho(): Buffer {
  const bytes = Buffer.alloc(4096)
  bytes.writeUInt32LE(0xfeedfacf)
  bytes.writeUInt32LE(0x0100000c, 4)
  bytes.writeUInt32LE(2, 12)
  bytes.writeUInt32LE(1, 16)
  bytes.writeUInt32LE(232, 20)
  bytes.writeUInt32LE(0x19, 32)
  bytes.writeUInt32LE(232, 36)
  bytes.write('__TEXT', 40)
  bytes.writeBigUInt64LE(0x100000000n, 56)
  bytes.writeBigUInt64LE(4096n, 64)
  bytes.writeBigUInt64LE(4096n, 80)
  bytes.writeUInt32LE(5, 88)
  bytes.writeUInt32LE(5, 92)
  bytes.writeUInt32LE(2, 96)
  for (const [header, name, offset, size] of [
    [104, '__bun_features', 512, 536],
    [184, '__bun_trim', 1048, 16],
  ] as const) {
    bytes.write(name, header)
    bytes.write('__TEXT', header + 16)
    bytes.writeBigUInt64LE(0x100000000n + BigInt(offset), header + 32)
    bytes.writeBigUInt64LE(BigInt(size), header + 40)
    bytes.writeUInt32LE(offset, header + 48)
    bytes.writeUInt32LE(3, header + 52)
  }
  state(bytes, 512, 1048, 536n)
  return bytes
}

function pe(): Buffer {
  const bytes = Buffer.alloc(4096)
  bytes.write('MZ')
  bytes.writeUInt32LE(128, 60)
  bytes.writeUInt32LE(0x4550, 128)
  bytes.writeUInt16LE(0x8664, 132)
  bytes.writeUInt16LE(2, 134)
  bytes.writeUInt16LE(112, 148)
  bytes.writeUInt16LE(2, 150)
  bytes.writeUInt16LE(0x20b, 152)
  bytes.writeBigUInt64LE(0x140000000n, 176)
  for (const [header, name, address, offset, size, rawSize] of [
    [264, '.bunfeat', 0x2000, 512, 536, 1024],
    [304, '.buntrim', 0x3000, 1536, 16, 512],
  ] as const) {
    bytes.write(name, header)
    bytes.writeUInt32LE(size, header + 8)
    bytes.writeUInt32LE(address, header + 12)
    bytes.writeUInt32LE(rawSize, header + 16)
    bytes.writeUInt32LE(offset, header + 20)
    bytes.writeUInt32LE(0x40000040, header + 36)
  }
  state(bytes, 512, 1536, 0x1000n)
  return bytes
}

function inspect(bytes: Buffer) {
  const path = join(directory, 'fixture')
  writeFileSync(path, bytes)
  return inspectBunRuntime(path)
}

test.each([
  ['Mach-O', macho, 'macho64-le', '__TEXT,__bun_features'],
  ['PE', pe, 'pe32+-le', '.bunfeat'],
] as const)(
  '%s resolves the named record and relative virtual range table',
  (_label, make, format, name) => {
    const bytes = make()
    // An unreferenced convincing-looking magic must not change the selected record.
    bytes.write('BUNFEAT\0', 3000)
    const actual = inspect(bytes)
    expect(actual.format).toBe(format)
    expect(actual.section).toEqual({ name, offset: 512, bytes: 536 })
    expect(actual.jit).toBe('unused')
    expect(actual.interpreter).toBe('present')
    expect(actual.jitRemovedRanges).toEqual({ count: 1, virtualBytes: 16 })
    bytes.writeUInt32LE(0, 524)
    bytes.writeBigInt64LE(0n, 528)
    bytes[536] = 0
    expect(inspect(bytes).jit).toBe('present')
    expect(inspect(bytes).removedRangeCount).toBe(0)
  }
)

test('Mach-O rejects objects, fat files and truncated or inconsistent command tables', () => {
  const object = macho()
  object.writeUInt32LE(1, 12)
  expect(() => inspect(object)).toThrow('thin Mach-O64 executable')
  const fat = macho()
  fat.writeUInt32BE(0xcafebabe)
  expect(() => inspect(fat)).toThrow('requires an ELF64')
  expect(() => inspect(macho().subarray(0, 20))).toThrow('thin Mach-O64')
  const commands = macho()
  commands.writeUInt32LE(1000, 16)
  expect(() => inspect(commands)).toThrow('load-command count')
  commands.writeUInt32LE(1, 16)
  commands.writeUInt32LE(240, 36)
  expect(() => inspect(commands)).toThrow('load-command size')
  commands.writeUInt32LE(232, 36)
  commands.writeUInt32LE(3, 96)
  expect(() => inspect(commands)).toThrow('segment layout')
})

test('Mach-O rejects misdirected, writable and duplicate named state sections', () => {
  const mapping = macho()
  mapping.writeUInt32LE(520, 104 + 48)
  expect(() => inspect(mapping)).toThrow('section mapping')
  const writable = macho()
  writable.writeUInt32LE(7, 92)
  expect(() => inspect(writable)).toThrow('section layout')
  const duplicate = macho()
  duplicate.copy(duplicate, 184, 104, 184)
  expect(() => inspect(duplicate)).toThrow('Expected exactly one')
  const missing = macho()
  missing.write('__not_features', 104)
  expect(() => inspect(missing)).toThrow('Expected exactly one')
})

test('Mach-O range pointers must resolve to one file-backed read-only section', () => {
  const ranges = macho()
  ranges.writeUInt32LE(2, 512 + 12)
  expect(() => inspect(ranges)).toThrow('removed-range table')
  const zeroFill = macho()
  zeroFill.writeUInt32LE(1, 184 + 64)
  expect(() => inspect(zeroFill)).toThrow('removed-range table')
})

test('PE rejects truncated headers, non-images, unsupported widths and section tables', () => {
  expect(() => inspect(pe().subarray(0, 63))).toThrow('DOS header')
  const outside = pe()
  outside.writeUInt32LE(0xffffffff, 60)
  expect(() => inspect(outside)).toThrow('outside the file')
  const dll = pe()
  dll.writeUInt16LE(0x2002, 150)
  expect(() => inspect(dll)).toThrow('PE32+ executable')
  const width = pe()
  width.writeUInt16LE(0x10b, 152)
  expect(() => inspect(width)).toThrow('PE32+ optional header')
  const count = pe()
  count.writeUInt16LE(97, 134)
  expect(() => inspect(count)).toThrow('PE32+ executable')
  expect(() => inspect(pe().subarray(0, 320))).toThrow('outside the file')
})

test('PE uses virtual state size while rejecting writable, unbacked and duplicate sections', () => {
  const size = pe()
  size.writeUInt32LE(535, 264 + 8)
  expect(() => inspect(size)).toThrow('section layout')
  const writable = pe()
  writable.writeUInt32LE(0xc0000040, 264 + 36)
  expect(() => inspect(writable)).toThrow('section layout')
  const unbacked = pe()
  unbacked.writeUInt32LE(512, 264 + 16)
  expect(() => inspect(unbacked)).toThrow('section layout')
  const duplicate = pe()
  duplicate.copy(duplicate, 304, 264, 304)
  expect(() => inspect(duplicate)).toThrow('Expected exactly one')
})

test('PE range pointers cannot use virtual zero fill or a section outside the file', () => {
  const ranges = pe()
  ranges.writeUInt32LE(513, 304 + 8)
  expect(() => inspect(ranges)).toThrow('removed-range table')
  const outside = pe()
  outside.writeUInt32LE(4096, 304 + 20)
  expect(() => inspect(outside)).toThrow('outside the file')
  const overflow = pe()
  overflow.writeBigUInt64LE(0xfffffffffffff000n, 176)
  expect(() => inspect(overflow)).toThrow('section address')
})

test.each([
  ['Mach-O', macho, 104],
  ['PE', pe, 264],
] as const)(
  '%s does not mask high bits into a canonical feature section name',
  (_label, make, offset) => {
    const bytes = make()
    bytes[offset] = bytes[offset]! | 0x80
    expect(() => inspect(bytes)).toThrow('Expected exactly one')
  }
)

test.each([
  ['feature state', 264, 'runtime feature mapping'],
  ['range table', 304, 'removed-range table'],
] as const)('PE rejects writable mapped aliases of the %s', (_label, original, message) => {
  const bytes = pe()
  bytes.writeUInt16LE(3, 134)
  bytes.copy(bytes, 344, original, original + 40)
  bytes.fill(0, 344, 352)
  bytes.write('.alias', 344)
  bytes.writeUInt32LE(0xc0000040, 344 + 36)
  expect(() => inspect(bytes)).toThrow(message)
})

test('Mach-O rejects a differently named overlapping feature mapping', () => {
  const bytes = macho()
  bytes.writeUInt32LE(312, 20)
  bytes.writeUInt32LE(312, 36)
  bytes.writeUInt32LE(3, 96)
  bytes.copy(bytes, 264, 104, 184)
  bytes.fill(0, 264, 280)
  bytes.write('__alias', 264)
  expect(() => inspect(bytes)).toThrow('runtime feature mapping')
})

test('Mach-O accepts pinned Bun numbered segment pieces with original section names', () => {
  const bytes = macho()
  bytes.write('__TEXT.7', 40)
  expect(inspect(bytes).section.name).toBe('__TEXT,__bun_features')
  expect(inspect(bytes).jitRemovedRanges.count).toBe(1)
  for (const name of ['__DATA.7', '__TEXT.0', '__TEXT.07', '__TEXT.bad']) {
    const invalid = macho()
    invalid.fill(0, 40, 56)
    invalid.write(name, 40)
    expect(() => inspect(invalid)).toThrow('section mapping')
  }
})

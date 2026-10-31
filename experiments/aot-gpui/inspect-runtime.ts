import { readFileSync } from 'node:fs'

// Pinned Bun da867c60: src/trim/removable_features/state.rs and
// scripts/build/trim/features.ts. engine.def assigns JIT=0, Interpreter=1,
// ImageCompiler=3. Executable layouts follow src/exe_format/{elf,macho,pe}.rs.
// Named, file-backed sections locate records; a magic-byte search is not proof.
const stateSize = 536
const removalOffset = 24
const featureCount = 512
const states = ['present', 'unused', 'requested'] as const

type Section = {
  name: string
  address: bigint
  offset: bigint
  size: bigint
  mapped: boolean
  mappedSize: bigint
  readOnlyData: boolean
}

function bounded(bytes: Buffer, offset: bigint, length: bigint): number {
  if (offset < 0n || length < 0n || offset + length > BigInt(bytes.length))
    throw new Error('Executable range extends outside the file')
  return Number(offset)
}

function elfSections(bytes: Buffer): Section[] {
  if (
    bytes.length < 64 ||
    bytes.readUInt32LE(0) !== 0x464c457f ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16)) ||
    bytes.readUInt32LE(20) !== 1 ||
    bytes.readUInt16LE(52) !== 64 ||
    bytes.readUInt16LE(58) !== 64
  )
    throw new Error('Runtime feature inspection requires a little-endian ELF64 executable')
  const count = bytes.readUInt16LE(60)
  const namesIndex = bytes.readUInt16LE(62)
  if (count === 0 || namesIndex === 0 || namesIndex >= count)
    throw new Error('Missing or unsupported ELF section table')
  const table = bounded(bytes, bytes.readBigUInt64LE(40), BigInt(count * 64))
  const raw = Array.from({ length: count }, (_, index) => {
    const offset = table + index * 64
    return {
      nameOffset: bytes.readUInt32LE(offset),
      type: bytes.readUInt32LE(offset + 4),
      flags: bytes.readBigUInt64LE(offset + 8),
      address: bytes.readBigUInt64LE(offset + 16),
      offset: bytes.readBigUInt64LE(offset + 24),
      size: bytes.readBigUInt64LE(offset + 32),
    }
  })
  const names = raw[namesIndex]
  if (!names || names.type !== 3) throw new Error('Invalid ELF section-name table')
  const namesStart = bounded(bytes, names.offset, names.size)
  const nameBytes = bytes.subarray(namesStart, namesStart + Number(names.size))
  return raw.map((section) => {
    if (BigInt(section.nameOffset) >= names.size)
      throw new Error('ELF section name is outside the string table')
    const end = nameBytes.indexOf(0, section.nameOffset)
    if (end < section.nameOffset) throw new Error('Unterminated ELF section name')
    return {
      ...section,
      name: nameBytes.toString('utf8', section.nameOffset, end),
      mapped: (section.flags & 2n) !== 0n,
      mappedSize: section.size,
      readOnlyData: section.type === 1 && (section.flags & 3n) === 2n,
    }
  })
}

function fixedName(bytes: Buffer, offset: number, length: number): string {
  const name = bytes.subarray(offset, offset + length)
  const end = name.indexOf(0)
  // Node's ASCII decoder clears the high bit and would alias malformed names.
  return name.toString('latin1', 0, end < 0 ? length : end)
}

function segmentMatches(owner: string, declared: string): boolean {
  if (owner === declared) return true
  // Pinned Bun macho_ranges.rs splits trimmed segments into NAME, NAME.1, ...
  // and retains the original section.segname. Match its bounded name rewrite.
  const suffix = owner.match(/\.[1-9][0-9]*$/)?.[0]
  return suffix !== undefined && owner === declared.slice(0, 16 - suffix.length) + suffix
}

function machoSections(bytes: Buffer): Section[] {
  if (
    bytes.length < 32 ||
    ![0x01000007, 0x0100000c].includes(bytes.readUInt32LE(4)) ||
    bytes.readUInt32LE(12) !== 2
  )
    throw new Error('Runtime feature inspection requires a thin Mach-O64 executable')
  const count = bytes.readUInt32LE(16)
  const length = bytes.readUInt32LE(20)
  const end = bounded(bytes, 32n, BigInt(length)) + length
  if (count === 0 || count > length / 8) throw new Error('Invalid Mach-O load-command count')
  const sections: Section[] = []
  let command = 32
  for (let index = 0; index < count; index++) {
    if (command + 8 > end) throw new Error('Truncated Mach-O load command')
    const kind = bytes.readUInt32LE(command)
    const size = bytes.readUInt32LE(command + 4)
    if (size < 8 || size % 8 !== 0 || command + size > end)
      throw new Error('Invalid Mach-O load-command size')
    if (kind === 0x19) {
      if (size < 72) throw new Error('Truncated Mach-O segment')
      const name = fixedName(bytes, command + 8, 16)
      const address = bytes.readBigUInt64LE(command + 24)
      const virtualSize = bytes.readBigUInt64LE(command + 32)
      const offset = bytes.readBigUInt64LE(command + 40)
      const fileSize = bytes.readBigUInt64LE(command + 48)
      const protection = bytes.readUInt32LE(command + 60)
      const sectionCount = bytes.readUInt32LE(command + 64)
      if (size !== 72 + sectionCount * 80 || address + virtualSize > 0xffffffffffffffffn)
        throw new Error('Invalid Mach-O segment layout')
      bounded(bytes, offset, fileSize)
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
        const header = command + 72 + sectionIndex * 80
        const sectionName = fixedName(bytes, header, 16)
        const segmentName = fixedName(bytes, header + 16, 16)
        const sectionAddress = bytes.readBigUInt64LE(header + 32)
        const sectionSize = bytes.readBigUInt64LE(header + 40)
        const sectionOffset = BigInt(bytes.readUInt32LE(header + 48))
        const kind = bytes.readUInt32LE(header + 64) & 0xff
        const fileBacked = ![1, 0xc, 0x12].includes(kind)
        if (
          !segmentMatches(name, segmentName) ||
          sectionAddress < address ||
          sectionAddress + sectionSize > address + virtualSize ||
          (fileBacked &&
            (sectionOffset < offset ||
              sectionOffset + sectionSize > offset + fileSize ||
              sectionAddress - address !== sectionOffset - offset))
        )
          throw new Error('Invalid Mach-O section mapping')
        sections.push({
          name: `${segmentName},${sectionName}`,
          address: sectionAddress,
          offset: sectionOffset,
          size: sectionSize,
          mapped: true,
          mappedSize: sectionSize,
          readOnlyData: kind === 0 && (protection & 3) === 1,
        })
      }
    }
    command += size
  }
  if (command !== end) throw new Error('Mach-O load commands do not fill their declared table')
  return sections
}

function peSections(bytes: Buffer): Section[] {
  if (bytes.length < 64) throw new Error('Truncated PE DOS header')
  const header = bounded(bytes, BigInt(bytes.readUInt32LE(60)), 24n)
  const optionalSize = bytes.readUInt16LE(header + 20)
  const count = bytes.readUInt16LE(header + 6)
  if (
    bytes.readUInt32LE(header) !== 0x4550 ||
    ![0x8664, 0xaa64].includes(bytes.readUInt16LE(header + 4)) ||
    (bytes.readUInt16LE(header + 22) & 0x2002) !== 2 ||
    optionalSize < 112 ||
    count === 0 ||
    count > 96
  )
    throw new Error('Runtime feature inspection requires a PE32+ executable')
  const optional = bounded(bytes, BigInt(header + 24), BigInt(optionalSize))
  if (bytes.readUInt16LE(optional) !== 0x20b)
    throw new Error('Runtime feature inspection requires a PE32+ optional header')
  const imageBase = bytes.readBigUInt64LE(optional + 24)
  const table = bounded(bytes, BigInt(optional + optionalSize), BigInt(count * 40))
  return Array.from({ length: count }, (_, index) => {
    const section = table + index * 40
    const size = bytes.readUInt32LE(section + 8)
    const address = imageBase + BigInt(bytes.readUInt32LE(section + 12))
    const fileSize = bytes.readUInt32LE(section + 16)
    const offset = BigInt(bytes.readUInt32LE(section + 20))
    const flags = bytes.readUInt32LE(section + 36)
    bounded(bytes, offset, BigInt(fileSize))
    if (address + BigInt(Math.max(size, fileSize)) > 0xffffffffffffffffn)
      throw new Error('Invalid PE section address')
    return {
      name: fixedName(bytes, section, 8),
      address,
      offset,
      size: BigInt(size),
      mapped: true,
      mappedSize: BigInt(Math.max(size, fileSize)),
      readOnlyData: (flags & 0xc0000040) === 0x40000040 && size <= fileSize,
    }
  })
}

function imageSections(bytes: Buffer) {
  const magic = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0
  if (magic === 0x464c457f)
    return { format: 'elf64-le' as const, name: '.bun_features', table: elfSections(bytes) }
  if (magic === 0xfeedfacf)
    return {
      format: 'macho64-le' as const,
      name: '__TEXT,__bun_features',
      table: machoSections(bytes),
    }
  if (bytes.length >= 2 && bytes.readUInt16LE(0) === 0x5a4d)
    return { format: 'pe32+-le' as const, name: '.bunfeat', table: peSections(bytes) }
  throw new Error('Runtime feature inspection requires an ELF64, Mach-O64 or PE32+ executable')
}

function overlappingMappings(table: Section[], start: bigint, length: bigint): Section[] {
  return table.filter(
    (entry) =>
      entry.mapped && entry.address < start + length && start < entry.address + entry.mappedSize
  )
}

export function inspectBunRuntime(path: string) {
  const bytes = readFileSync(path)
  const { format, name, table } = imageSections(bytes)
  const candidates = table.filter((section) => section.name === name)
  const section = candidates[0]
  if (candidates.length !== 1 || !section) throw new Error(`Expected exactly one ${name} section`)
  if (
    !section.readOnlyData ||
    section.size !== BigInt(stateSize) ||
    section.address % 8n !== 0n ||
    section.offset % 8n !== 0n
  )
    throw new Error(`Invalid ${name} section layout`)
  if (overlappingMappings(table, section.address, section.size).length !== 1)
    throw new Error('Ambiguous Bun runtime feature mapping')
  const offset = bounded(bytes, section.offset, section.size)
  const state = bytes.subarray(offset, offset + stateSize)
  if (!state.subarray(0, 8).equals(Buffer.from('BUNFEAT\0')))
    throw new Error('Invalid Bun runtime feature magic')
  const trimmed = state.readUInt32LE(8)
  const rangeCount = state.readUInt32LE(12)
  const rangeOffset = state.readBigInt64LE(16)
  if (
    trimmed > 1 ||
    rangeCount > 32768 ||
    rangeOffset % 8n !== 0n ||
    (rangeCount === 0 && rangeOffset !== 0n) ||
    state.subarray(removalOffset).some((value) => value > 2)
  )
    throw new Error('Invalid Bun runtime feature state')

  let jitRangeCount = 0
  let jitRangeBytes = 0
  if (rangeCount > 0) {
    const start = section.address + rangeOffset
    const length = BigInt(rangeCount * 16)
    // Check every mapped alias before testing permissions. Filtering writable
    // mappings first could falsely qualify an ambiguous table as read-only.
    const ranges = overlappingMappings(table, start, length)
    const rangeSection = ranges[0]
    if (
      ranges.length !== 1 ||
      !rangeSection ||
      !rangeSection.readOnlyData ||
      rangeSection.address > start ||
      start + length > rangeSection.address + rangeSection.size
    )
      throw new Error('Missing or ambiguous Bun removed-range table')
    bounded(bytes, rangeSection.offset, rangeSection.size)
    const rangeStart = bounded(bytes, rangeSection.offset + start - rangeSection.address, length)
    let previousEnd = 0n
    for (let index = 0; index < rangeCount; index++) {
      const record = rangeStart + index * 16
      const address = section.address + bytes.readBigInt64LE(record)
      const size = bytes.readUInt32LE(record + 8)
      const feature = bytes.readUInt16LE(record + 12)
      if (
        address < previousEnd ||
        address + BigInt(size) > 0xffffffffffffffffn ||
        size === 0 ||
        feature >= featureCount ||
        bytes.readUInt16LE(record + 14) !== 0
      )
        throw new Error('Invalid Bun removed-range record')
      previousEnd = address + BigInt(size)
      if (feature === 0) {
        jitRangeCount++
        jitRangeBytes += size
      }
    }
  }
  return {
    format,
    section: { name: section.name, offset, bytes: stateSize },
    rawRecordHex: state.toString('hex'),
    trimmedProgramFeatures: trimmed === 1,
    removedRangeCount: rangeCount,
    jit: states[state[removalOffset]!]!,
    interpreter: states[state[removalOffset + 1]!]!,
    imageCompiler: states[state[removalOffset + 3]!]!,
    jitRemovedRanges: { count: jitRangeCount, virtualBytes: jitRangeBytes },
  }
}

import { describe, expect, test } from 'bun:test'
import {
  differingRanges,
  explainDifference,
  peRegions,
  renderDifference,
} from '../../scripts/quality/binary-diff.ts'

/**
 * A minimal PE32+ image: DOS header, COFF header, optional header with a debug
 * data directory, one `.rdata` section holding a CodeView (RSDS) and a REPRO
 * debug directory entry.
 */
function pe(options: { stamp: number; guid: number; path: string; code: number }) {
  const bytes = new Uint8Array(0x600)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0x5a4d, true)
  const peAt = 0x80
  view.setUint32(0x3c, peAt, true)
  view.setUint32(peAt, 0x00004550, true)
  const coff = peAt + 4
  view.setUint16(coff, 0x8664, true)
  view.setUint16(coff + 2, 2, true)
  view.setUint32(coff + 4, options.stamp, true)
  const optionalSize = 240
  view.setUint16(coff + 16, optionalSize, true)
  const optional = coff + 20
  view.setUint16(optional, 0x20b, true)
  view.setUint32(optional + 108, 16, true)
  view.setUint32(optional + 64, options.stamp ^ 0xffff, true)
  const table = optional + optionalSize
  const section = (index: number, name: string, rva: number, raw: number, size: number) => {
    const at = table + index * 40
    bytes.set(new TextEncoder().encode(name), at)
    view.setUint32(at + 8, size, true)
    view.setUint32(at + 12, rva, true)
    view.setUint32(at + 16, size, true)
    view.setUint32(at + 20, raw, true)
  }
  section(0, '.text', 0x1000, 0x200, 0x200)
  section(1, '.rdata', 0x2000, 0x400, 0x200)
  view.setUint32(0x200 + 0x10, options.code, true)
  // Debug directory at RVA 0x2000 (file 0x400): CodeView then REPRO.
  view.setUint32(optional + 112 + 6 * 8, 0x2000, true)
  view.setUint32(optional + 112 + 6 * 8 + 4, 56, true)
  const codeview = 0x480
  const path = new TextEncoder().encode(`${options.path}\0`)
  view.setUint32(0x400 + 4, options.stamp, true)
  view.setUint32(0x400 + 12, 2, true)
  view.setUint32(0x400 + 16, 24 + path.length, true)
  view.setUint32(0x400 + 24, codeview, true)
  view.setUint32(codeview, 0x53445352, true)
  view.setUint32(codeview + 4, options.guid, true)
  view.setUint32(codeview + 20, 1, true)
  bytes.set(path, codeview + 24)
  view.setUint32(0x400 + 28 + 12, 16, true)
  view.setUint32(0x400 + 28 + 16, 4, true)
  view.setUint32(0x400 + 28 + 24, 0x500, true)
  view.setUint32(0x500, options.guid, true)
  return bytes
}

describe('differing ranges', () => {
  test('merges adjacent bytes and reports a length tail', () => {
    const a = Uint8Array.from([1, 2, 3, 4, 5, 6])
    expect(differingRanges(a, a)).toEqual([])
    expect(differingRanges(a, Uint8Array.from([1, 9, 9, 4, 5, 9]))).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ])
    expect(differingRanges(a, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([
      { start: 6, end: 8 },
    ])
    expect(differingRanges(a, Uint8Array.from([1, 2, 3, 4, 5, 0, 7]))).toEqual([
      { start: 5, end: 7 },
    ])
  })
})

describe('PE regions', () => {
  test('rejects files that are not PE images', () => {
    expect(peRegions(new Uint8Array(16))).toBeNull()
    const noSignature = pe({ stamp: 1, guid: 1, path: 'x.pdb', code: 1 })
    noSignature[0x80] = 0
    expect(peRegions(noSignature)).toBeNull()
    const badMagic = pe({ stamp: 1, guid: 1, path: 'x.pdb', code: 1 })
    new DataView(badMagic.buffer).setUint16(0x80 + 24, 0x999, true)
    expect(peRegions(badMagic)).toBeNull()
  })

  test('does not invent debug metadata from undeclared or out-of-bounds optional directories', () => {
    const bytes = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const view = new DataView(bytes.buffer)
    const coff = 0x80 + 4
    const optional = coff + 20
    const directoryCount = optional + 108
    const timestamps = () =>
      peRegions(bytes)?.regions.filter((region) => region.name === 'debug directory TimeDateStamp')

    // The bytes may be present, but NumberOfRvaAndSizes does not declare
    // the debug directory unless it includes entry 6.
    view.setUint32(directoryCount, 0, true)
    expect(peRegions(bytes)?.pdbPath).toBeNull()
    expect(timestamps()).toEqual([])
    view.setUint32(directoryCount, 6, true)
    expect(peRegions(bytes)?.pdbPath).toBeNull()
    expect(timestamps()).toEqual([])
    view.setUint32(directoryCount, 7, true)
    expect(peRegions(bytes)?.pdbPath).toBe('host.pdb')

    // The directory count alone is insufficient if SizeOfOptionalHeader
    // ends before entry 6. Poison the first section name with bytes that
    // would otherwise be read as a valid debug RVA/size pair.
    view.setUint32(directoryCount, 16, true)
    const table = optional + 240
    const shortTable = optional + 160
    bytes.copyWithin(shortTable, table, table + 80)
    bytes.set([0, 0x20, 0, 0, 56, 0, 0, 0], shortTable)
    view.setUint16(coff + 16, 160, true)
    expect(peRegions(bytes)?.pdbPath).toBeNull()
    expect(timestamps()).toEqual([])

    // A header lacking even the fixed optional fields is not a PE image
    // whose debug metadata can be analyzed.
    view.setUint16(coff + 16, 16, true)
    expect(peRegions(bytes)).toBeNull()
  })

  test('rejects truncated or inflated COFF section tables', () => {
    const complete = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    expect(peRegions(complete)?.pdbPath).toBe('host.pdb')

    // The COFF header declares two 40-byte section headers; only one remains.
    // A partial table is not a valid map for diagnosing the PE image.
    const sectionTable = 0x80 + 4 + 20 + 240
    expect(peRegions(complete.subarray(0, sectionTable + 40))).toBeNull()

    // Previously an exaggerated section count generated a fictitious header
    // region spanning millions of bytes beyond the actual file.
    const inflated = complete.slice()
    new DataView(inflated.buffer).setUint16(0x80 + 4 + 2, 0xffff, true)
    expect(peRegions(inflated)).toBeNull()
  })

  test('does not map a virtual-only debug RVA into unrelated raw section bytes', () => {
    const bytes = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const view = new DataView(bytes.buffer)
    const coff = 0x80 + 4
    const optional = coff + 20
    const table = optional + 240
    // .text maps 0x200 raw bytes but reserves 0x500 virtual bytes. RVA 0x1300
    // is inside its zero-filled tail; raw + 0x300 points into .rdata on disk.
    view.setUint32(table + 8, 0x500, true)
    view.setUint32(optional + 112 + 6 * 8, 0x1300, true)
    const parsed = peRegions(bytes)
    expect(parsed).not.toBeNull()
    expect(parsed?.pdbPath).toBeNull()
    expect(parsed?.regions.filter((region) => region.name === 'debug directory TimeDateStamp')).toEqual([])
  })

  test('does not read a debug directory across raw section boundaries', () => {
    const bytes = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const view = new DataView(bytes.buffer)
    const debugRva = 0x80 + 4 + 20 + 112 + 6 * 8
    // Only 16 bytes of .text remain at RVA 0x11f0. The 56-byte directory
    // would otherwise read unrelated on-disk .rdata bytes after that boundary.
    view.setUint32(debugRva, 0x11f0, true)
    const crossing = peRegions(bytes)
    expect(crossing).not.toBeNull()
    expect(crossing?.pdbPath).toBeNull()
    expect(
      crossing?.regions.filter((region) => region.name === 'debug directory TimeDateStamp')
    ).toEqual([])

    // A full 56-byte table ending exactly at the raw boundary remains mapped.
    view.setUint32(debugRva, 0x11c8, true)
    const within = peRegions(bytes)
    expect(
      within?.regions.filter((region) => region.name === 'debug directory TimeDateStamp')
    ).toHaveLength(2)
  })

  test('does not classify incomplete CodeView or REPRO payloads as file-backed bytes', () => {
    const bytes = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const view = new DataView(bytes.buffer)
    const entry = 0x400
    const codeview = 0x480

    // The fixed 24-byte RSDS header must fit inside the declared SizeOfData.
    view.setUint32(entry + 16, 4, true)
    expect(peRegions(bytes)?.pdbPath).toBeNull()
    expect(peRegions(bytes)?.regions.some((region) => region.name === 'CodeView GUID')).toBe(false)

    // A signature four bytes before EOF is not a complete CodeView record.
    view.setUint32(entry + 16, 28, true)
    view.setUint32(entry + 24, bytes.length - 4, true)
    view.setUint32(bytes.length - 4, 0x53445352, true)
    const truncated = peRegions(bytes)
    expect(truncated?.pdbPath).toBeNull()
    expect(truncated?.regions.some((region) => region.name === 'CodeView GUID')).toBe(false)

    // An in-bounds signature cannot authenticate a declared payload beyond EOF.
    view.setUint32(entry + 16, 0x200, true)
    view.setUint32(entry + 24, codeview, true)
    expect(peRegions(bytes)?.pdbPath).toBeNull()

    // Restore the complete CodeView record; reject only the truncated REPRO
    // record instead of inventing a hash region outside the file.
    view.setUint32(entry + 16, 24 + 'host.pdb'.length + 1, true)
    view.setUint32(entry + 28 + 24, bytes.length - 2, true)
    const repro = peRegions(bytes)
    expect(repro?.pdbPath).toBe('host.pdb')
    expect(repro?.regions.some((region) => region.name === 'REPRO hash')).toBe(false)

    // A zero PointerToRawData cannot identify a hash in the DOS header.
    view.setUint32(entry + 28 + 24, 0, true)
    expect(peRegions(bytes)?.regions.some((region) => region.name === 'REPRO hash')).toBe(false)
  })

  test('does not invent a PDB path when an RSDS record lacks its terminator', () => {
    const bytes = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const view = new DataView(bytes.buffer)
    const terminator = 0x480 + 24 + 'host.pdb'.length
    expect(peRegions(bytes)?.pdbPath).toBe('host.pdb')

    // A fully file-backed RSDS header and GUID are not enough: the declared
    // path bytes must contain the mandatory NUL terminator.
    bytes[terminator] = 0x58
    const unterminated = peRegions(bytes)
    expect(unterminated?.pdbPath).toBeNull()
    expect(unterminated?.regions.some((region) => region.name === 'CodeView GUID')).toBe(true)
    expect(unterminated?.regions.some((region) => region.name === 'CodeView PDB path')).toBe(
      false
    )

    // NUL plus additional declared padding remains a valid PDB path.
    bytes[terminator] = 0
    view.setUint32(0x400 + 16, 24 + 'host.pdb'.length + 1 + 3, true)
    expect(peRegions(bytes)?.pdbPath).toBe('host.pdb')
  })

  test('does not call bytes after the PDB terminator a PDB path difference', () => {
    const a = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const b = a.slice()
    const declared = 24 + 'host.pdb'.length + 1 + 3
    new DataView(a.buffer).setUint32(0x400 + 16, declared, true)
    new DataView(b.buffer).setUint32(0x400 + 16, declared, true)
    const pathStart = 0x480 + 24
    const padding = pathStart + 'host.pdb'.length + 1

    // Different CodeView padding does not change either NUL-terminated identity.
    b[padding] = 0x58
    const difference = explainDifference(a, b)
    expect(difference.pdbPaths).toEqual(['host.pdb', 'host.pdb'])
    expect(difference.regions).toEqual([{ name: 'section .rdata', bytes: 1, ranges: 1 }])

    // Changes inside the actual filename still belong to the PDB-path region.
    const changedPath = a.slice()
    changedPath[pathStart] = 'H'.charCodeAt(0)
    expect(explainDifference(a, changedPath).regions).toEqual([
      { name: 'CodeView PDB path', bytes: 1, ranges: 1 },
    ])
  })

  test('does not select an arbitrary PDB path from conflicting CodeView records', () => {
    const bytes = pe({ stamp: 1, guid: 1, path: 'first.pdb', code: 1 })
    const view = new DataView(bytes.buffer)
    const second = 0x400 + 28
    const writeCodeView = (entry: number, pointer: number, filename: string) => {
      const path = new TextEncoder().encode(filename)
      view.setUint32(entry + 12, 2, true)
      view.setUint32(entry + 16, 24 + path.length + 1, true)
      view.setUint32(entry + 24, pointer, true)
      view.setUint32(pointer, 0x53445352, true)
      view.setUint32(pointer + 20, 1, true)
      bytes.set(path, pointer + 24)
      bytes[pointer + 24 + path.length] = 0
    }

    // Several complete CodeView entries with the same path are consistent.
    writeCodeView(second, 0x540, 'first.pdb')
    expect(peRegions(bytes)?.pdbPath).toBe('first.pdb')

    // A different valid second path makes the image ambiguous: last-wins
    // would otherwise report 'second.pdb' as its only PDB identity.
    writeCodeView(second, 0x540, 'second.pdb')
    expect(peRegions(bytes)?.pdbPath).toBeNull()

    // Later entries must not restore a single path after a contradiction.
    const optional = 0x80 + 4 + 20
    view.setUint32(optional + 112 + 6 * 8 + 4, 84, true)
    writeCodeView(0x400 + 56, 0x580, 'first.pdb')
    const parsed = peRegions(bytes)
    expect(parsed?.pdbPath).toBeNull()
    expect(parsed?.regions.filter((region) => region.name === 'CodeView PDB path')).toHaveLength(3)
  })

  test('does not map header-aliasing or truncated raw sections as PE data', () => {
    const make = () => pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const table = 0x80 + 4 + 20 + 240
    const debugSize = 0x80 + 4 + 20 + 112 + 6 * 8 + 4

    // A corrupt .rdata raw pointer of zero aliases the DOS header. The
    // apparent CodeView record at that offset must not fabricate a PDB path
    // or claim DOS-header differences as .rdata section data.
    const alias = make()
    const aliasView = new DataView(alias.buffer)
    aliasView.setUint32(table + 40 + 20, 0, true)
    aliasView.setUint32(debugSize, 28, true)
    aliasView.setUint32(12, 2, true)
    aliasView.setUint32(16, 24 + 'host.pdb'.length + 1, true)
    aliasView.setUint32(24, 0x480, true)
    const parsedAlias = peRegions(alias)
    expect(parsedAlias?.pdbPath).toBeNull()
    expect(
      parsedAlias?.regions.filter((region) => region.name === 'debug directory TimeDateStamp')
    ).toEqual([])
    expect(parsedAlias?.regions.some((region) => region.name === 'section .rdata')).toBe(false)
    const changedHeader = alias.slice()
    changedHeader[0x41] = 0x58
    expect(explainDifference(alias, changedHeader).regions).toEqual([
      { name: 'headers', bytes: 1, ranges: 1 },
    ])

    // A section whose declared raw extent goes past EOF is not file-backed,
    // even if the bytes at the beginning of the incomplete range resemble
    // a fully in-bounds debug directory and independent CodeView record.
    const truncated = make()
    const truncatedView = new DataView(truncated.buffer)
    truncatedView.setUint32(table + 40 + 20, 0x580, true)
    truncatedView.setUint32(debugSize, 28, true)
    truncatedView.setUint32(0x580 + 12, 2, true)
    truncatedView.setUint32(0x580 + 16, 24 + 'host.pdb'.length + 1, true)
    truncatedView.setUint32(0x580 + 24, 0x480, true)
    const parsedTruncated = peRegions(truncated)
    expect(parsedTruncated?.pdbPath).toBeNull()
    expect(parsedTruncated?.regions.some((region) => region.name === 'section .rdata')).toBe(false)

    // A complete, normally mapped .rdata section retains its PDB identity.
    expect(peRegions(make())?.pdbPath).toBe('host.pdb')
  })

  test('refuses overlapping raw or RVA section aliases in PE diagnostic attribution', () => {
    const make = () => pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const table = 0x80 + 4 + 20 + 240
    const sections = (bytes: Uint8Array) =>
      peRegions(bytes)?.regions.filter((region) => region.name.startsWith('section '))

    // Both file-backed sections claim the same raw bytes. The old parser
    // reported a PDB path from .rdata and attributed its bytes to .text.
    const rawAlias = make()
    new DataView(rawAlias.buffer).setUint32(table + 20, 0x400, true)
    expect(peRegions(rawAlias)?.pdbPath).toBeNull()
    expect(sections(rawAlias)).toEqual([])
    const modified = rawAlias.slice()
    modified[0x410] ^= 1
    expect(explainDifference(rawAlias, modified).regions).toEqual([
      { name: 'unmapped', bytes: 1, ranges: 1 },
    ])

    // Even a partial raw overlap has no unique section owner.
    const partial = make()
    new DataView(partial.buffer).setUint32(table + 20, 0x300, true)
    expect(sections(partial)).toEqual([])

    // Two different raw locations claiming the same RVA are equally
    // ambiguous when translating a debug-directory RVA.
    const rvaAlias = make()
    new DataView(rvaAlias.buffer).setUint32(table + 12, 0x2000, true)
    expect(peRegions(rvaAlias)?.pdbPath).toBeNull()
    expect(sections(rvaAlias)).toEqual([])

    // Properly disjoint, adjacent sections still retain all metadata.
    const valid = make()
    expect(peRegions(valid)?.pdbPath).toBe('host.pdb')
    expect(sections(valid)?.map((region) => region.name)).toEqual([
      'section .text',
      'section .rdata',
    ])
  })

  test('uses the earliest file-backed section rather than an uninitialized section for headers', () => {
    const a = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const view = new DataView(a.buffer)
    const table = 0x80 + 4 + 20 + 240

    // A valid zero-filled .bss can precede the first section with raw data.
    // PointerToRawData=0 is not the end of the DOS/PE headers.
    a.fill(0, table, table + 8)
    a.set(new TextEncoder().encode('.bss'), table)
    view.setUint32(table + 16, 0, true)
    view.setUint32(table + 20, 0, true)
    expect(peRegions(a)?.pdbPath).toBe('host.pdb')
    expect(peRegions(a)?.regions.find((region) => region.name === 'headers')).toEqual({
      name: 'headers',
      start: 0,
      end: 0x400,
    })
    const b = a.slice()
    b[0x41] = 0x58
    expect(explainDifference(a, b).regions).toEqual([
      { name: 'headers', bytes: 1, ranges: 1 },
    ])

    // With no file-backed section, the complete COFF section table is the
    // header boundary, never a zero PointerToRawData value.
    const noRaw = a.slice()
    const noRawView = new DataView(noRaw.buffer)
    noRawView.setUint32(table + 40 + 16, 0, true)
    noRawView.setUint32(table + 40 + 20, 0, true)
    expect(peRegions(noRaw)?.regions.find((region) => region.name === 'headers')?.end).toBe(
      table + 80
    )

    // The section-table order does not determine on-disk header extent.
    const reordered = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 1 })
    const reorderedView = new DataView(reordered.buffer)
    reorderedView.setUint32(table + 20, 0x400, true)
    reorderedView.setUint32(table + 40 + 20, 0x200, true)
    expect(peRegions(reordered)?.regions.find((region) => region.name === 'headers')?.end).toBe(
      0x200
    )
  })

  test('names header, debug directory and section regions and reads the PDB path', () => {
    const parsed = peRegions(pe({ stamp: 1, guid: 1, path: 'bun_native_host.pdb', code: 1 }))
    expect(parsed?.pdbPath).toBe('bun_native_host.pdb')
    expect(parsed?.regions.map((region) => region.name)).toEqual([
      'COFF TimeDateStamp',
      'optional header CheckSum',
      'debug directory TimeDateStamp',
      'CodeView GUID',
      'CodeView age',
      'CodeView PDB path',
      'debug directory TimeDateStamp',
      'REPRO hash',
      'section .text',
      'section .rdata',
      'headers',
    ])
  })
})

describe('explaining a difference', () => {
  test('a relink with a new timestamp and PDB identity touches only those fields', () => {
    const a = pe({ stamp: 0x11111111, guid: 0x22222222, path: 'host.pdb', code: 7 })
    const b = pe({ stamp: 0x33333333, guid: 0x44444444, path: 'host.pdb', code: 7 })
    const difference = explainDifference(a, b)
    expect(difference.regions.map((region) => region.name)).toEqual([
      'COFF TimeDateStamp',
      'optional header CheckSum',
      'debug directory TimeDateStamp',
      'CodeView GUID',
      'REPRO hash',
    ])
    expect(difference.pdbPaths).toEqual(['host.pdb', 'host.pdb'])
    const lines = renderDifference('windows', difference).join('\n')
    expect(lines).toContain('Byte differences on windows')
    expect(lines).toContain('| CodeView GUID |')
    expect(lines).toContain('PDB paths: host.pdb | host.pdb')
  })

  test('a code difference is reported by section and non-PE bytes are unmapped', () => {
    const a = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 7 })
    const b = pe({ stamp: 1, guid: 1, path: 'host.pdb', code: 8 })
    expect(explainDifference(a, b).regions).toEqual([
      { name: 'section .text', bytes: 1, ranges: 1 },
    ])
    const plain = explainDifference(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))
    expect(plain.regions).toEqual([{ name: 'unmapped', bytes: 1, ranges: 1 }])
    expect(plain.pdbPaths).toEqual([null, null])
    expect(renderDifference('linux', plain).join('\n')).not.toContain('PDB paths')
  })
})

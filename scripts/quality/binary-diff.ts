// Explains where two builds of one executable differ (#223). The reproducibility
// comparison only knows that two hashes differ; this names the bytes. For a PE
// file it maps each differing range to the header field, debug directory entry
// or section that holds it, which is what separates a link timestamp or PDB
// identity from a real code difference.

export type Range = { start: number; end: number }

export type Region = { name: string; start: number; end: number }

export type Difference = {
  sizes: [number, number]
  differingBytes: number
  ranges: Range[]
  /** Differing byte count per named region, in file order; `unmapped` for the rest. */
  regions: { name: string; bytes: number; ranges: number }[]
  /** CodeView PDB paths of the two files when both are PE files with one. */
  pdbPaths: [string | null, string | null]
}

/** Maximal runs of differing bytes over the common length, then any length tail. */
export function differingRanges(a: Uint8Array, b: Uint8Array): Range[] {
  const ranges: Range[] = []
  const common = Math.min(a.length, b.length)
  let start = -1
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      ranges.push({ start, end: i })
      start = -1
    }
  }
  if (start >= 0) ranges.push({ start, end: common })
  if (a.length !== b.length) {
    const last = ranges.at(-1)
    const end = Math.max(a.length, b.length)
    if (last && last.end === common) last.end = end
    else ranges.push({ start: common, end })
  }
  return ranges
}

function reader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fits = (offset: number, size: number) => offset >= 0 && offset + size <= bytes.length
  return {
    fits,
    u16: (offset: number) => (fits(offset, 2) ? view.getUint16(offset, true) : null),
    u32: (offset: number) => (fits(offset, 4) ? view.getUint32(offset, true) : null),
  }
}

/**
 * Named regions of a PE/COFF image: the COFF timestamp, the optional header
 * checksum, each debug directory entry's timestamp, the CodeView (RSDS) GUID, age
 * and PDB path, any REPRO hash, and every section. Returns null for a file that
 * is not PE. More specific regions come first, so the first match names a byte.
 */
export function peRegions(bytes: Uint8Array): { regions: Region[]; pdbPath: string | null } | null {
  const r = reader(bytes)
  if (r.u16(0) !== 0x5a4d) return null
  const pe = r.u32(0x3c)
  if (pe === null || r.u32(pe) !== 0x00004550) return null
  const coff = pe + 4
  const sectionCount = r.u16(coff + 2)
  const optionalSize = r.u16(coff + 16)
  const optional = coff + 20
  const magic = r.u16(optional)
  // Require the fixed optional-header fields before interpreting any
  // directories: a short header can otherwise expose section-table bytes.
  const dataDirectoriesOffset = magic === 0x20b ? 112 : 96
  if (
    sectionCount === null ||
    optionalSize === null ||
    (magic !== 0x10b && magic !== 0x20b) ||
    optionalSize < dataDirectoriesOffset ||
    !r.fits(optional, optionalSize)
  )
    return null
  const regions: Region[] = [
    { name: 'COFF TimeDateStamp', start: coff + 4, end: coff + 8 },
    { name: 'optional header CheckSum', start: optional + 64, end: optional + 68 },
  ]
  const sections: {
    name: string
    rva: number
    raw: number
    rawSize: number
  }[] = []
  const table = optional + optionalSize
  for (let i = 0; i < sectionCount; i++) {
    const at = table + i * 40
    if (!r.fits(at, 40)) break
    const name = new TextDecoder().decode(bytes.subarray(at, at + 8)).replace(/\0+$/, '')
    sections.push({
      name,
      rva: r.u32(at + 12) as number,
      rawSize: r.u32(at + 16) as number,
      raw: r.u32(at + 20) as number,
    })
  }
  const fileOffset = (rva: number, size: number) => {
    for (const s of sections) {
      const offset = rva - s.rva
      // VirtualSize may include zero-filled memory beyond the file's raw
      // section bytes. A debug directory must also fit in one raw section:
      // accepting only its first byte could read the next on-disk section.
      if (
        offset >= 0 &&
        offset < s.rawSize &&
        offset + size <= s.rawSize &&
        r.fits(s.raw + offset, size)
      )
        return s.raw + offset
    }
    return null
  }
  let pdbPath: string | null = null
  // NumberOfRvaAndSizes, and the declared optional-header byte range,
  // must both include entry 6 before it can name a debug directory.
  const directoryCount = r.u32(optional + dataDirectoriesOffset - 4)
  const debugOffset = dataDirectoriesOffset + 6 * 8
  const hasDebugDirectory =
    directoryCount !== null && directoryCount > 6 && optionalSize >= debugOffset + 8
  const debugRva = hasDebugDirectory ? r.u32(optional + debugOffset) : null
  const debugSize = hasDebugDirectory ? (r.u32(optional + debugOffset + 4) ?? 0) : 0
  const debug = debugRva ? fileOffset(debugRva, debugSize) : null
  for (let i = 0; debug !== null && i < Math.floor(debugSize / 28); i++) {
    const entry = debug + i * 28
    if (!r.fits(entry, 28)) break
    const type = r.u32(entry + 12) as number
    const size = r.u32(entry + 16) as number
    const data = r.u32(entry + 24) as number
    regions.push({ name: `debug directory TimeDateStamp`, start: entry + 4, end: entry + 8 })
    // Debug payload pointers are raw file offsets, not validated by the
    // debug directory table's RVA bounds. Never name partial CodeView data.
    if (
      type === 2 &&
      size >= 24 &&
      r.fits(data, size) &&
      r.u32(data) === 0x53445352
    ) {
      regions.push({ name: 'CodeView GUID', start: data + 4, end: data + 20 })
      regions.push({ name: 'CodeView age', start: data + 20, end: data + 24 })
      const end = data + size
      const path = bytes.subarray(data + 24, end)
      const nul = path.indexOf(0)
      // RSDS filenames are NUL-terminated. Do not invent a PDB identity
      // from a record whose declared data ends before its path terminator.
      // The valid GUID and age fields remain independently attributable.
      if (nul >= 0) {
        regions.push({ name: 'CodeView PDB path', start: data + 24, end })
        pdbPath = new TextDecoder().decode(path.subarray(0, nul))
      }
    } else if (type === 16 && data > 0 && size > 0 && r.fits(data, size)) {
      regions.push({ name: 'REPRO hash', start: data, end: data + size })
    }
  }
  for (const s of sections)
    regions.push({ name: `section ${s.name}`, start: s.raw, end: s.raw + s.rawSize })
  regions.push({ name: 'headers', start: 0, end: sections[0]?.raw ?? table + sectionCount * 40 })
  return { regions, pdbPath }
}

/** Where `a` and `b` differ, by region when `a` is a PE image. */
export function explainDifference(a: Uint8Array, b: Uint8Array): Difference {
  const ranges = differingRanges(a, b)
  const pe = peRegions(a)
  const regions = pe?.regions ?? []
  const totals = new Map<string, { bytes: number; ranges: Set<number> }>()
  let differingBytes = 0
  ranges.forEach((range, index) => {
    for (let offset = range.start; offset < range.end; offset++) {
      differingBytes++
      const name =
        regions.find((region) => offset >= region.start && offset < region.end)?.name ?? 'unmapped'
      const total = totals.get(name) ?? { bytes: 0, ranges: new Set<number>() }
      total.bytes++
      total.ranges.add(index)
      totals.set(name, total)
    }
  })
  return {
    sizes: [a.length, b.length],
    differingBytes,
    ranges,
    regions: [...totals].map(([name, total]) => ({
      name,
      bytes: total.bytes,
      ranges: total.ranges.size,
    })),
    pdbPaths: [pe?.pdbPath ?? null, peRegions(b)?.pdbPath ?? null],
  }
}

export function renderDifference(os: string, difference: Difference): string[] {
  const lines = [
    '',
    `Byte differences on ${os}: ${difference.differingBytes} bytes in ${difference.ranges.length} ranges (sizes ${difference.sizes.join(', ')}).`,
    '',
    '| Region | Bytes | Ranges |',
    '| ------ | ----: | -----: |',
    ...difference.regions.map(
      (region) => `| ${region.name} | ${region.bytes} | ${region.ranges} |`
    ),
  ]
  if (difference.pdbPaths.some((path) => path !== null))
    lines.push('', `PDB paths: ${difference.pdbPaths.map((path) => path ?? '(none)').join(' | ')}`)
  const shown = difference.ranges.slice(0, 20)
  lines.push(
    '',
    `First ${shown.length} ranges: ${shown.map((r) => `0x${r.start.toString(16)}+${r.end - r.start}`).join(', ')}`
  )
  return lines
}

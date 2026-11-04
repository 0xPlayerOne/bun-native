import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { FileDigest } from './artifact.ts'
import { packagePath } from './paths.ts'

const block = 512
const maximumBytes = 64 * 1024 * 1024

function text(field: Buffer): string {
  const end = field.indexOf(0)
  if (end !== -1 && field.subarray(end).some((byte) => byte !== 0))
    throw new Error('Invalid package tar text padding')
  return field.subarray(0, end === -1 ? undefined : end).toString('latin1')
}

function octal(field: Buffer): number {
  const value = field.toString('latin1')
  if (!/^[\0 ]*[0-7]+[\0 ]*$/.test(value)) throw new Error('Invalid package tar numeric field')
  const number = Number.parseInt(value.replaceAll('\0', '').trim(), 8)
  if (!Number.isSafeInteger(number)) throw new Error('Invalid package tar size')
  return number
}

/** Inspect original USTAR members before any map can erase duplicates or link metadata. */
export async function verifyPackageArchive(
  path: string,
  expected: Record<string, FileDigest>
): Promise<void> {
  const files = new Map<string, FileDigest>()
  const directories = new Set<string>()
  let paddedContents = 0
  for (const [name, digest] of Object.entries(expected)) {
    if (!packagePath(name) || !Number.isSafeInteger(digest.bytes) || digest.bytes < 0)
      throw new Error('Invalid expected package archive inventory')
    const full = `package/${name}`
    files.set(full, digest)
    const parts = full.split('/')
    for (let index = 1; index < parts.length; index += 1)
      directories.add(parts.slice(0, index).join('/'))
    paddedContents += Math.ceil(digest.bytes / block) * block
  }
  // Permit the declared files, directory headers, end blocks and one conventional
  // 10 KiB blocking pad. Bound decompression before parsing any member contents.
  const limit = paddedContents + (files.size + directories.size + 2) * block + 10_240
  if (!Number.isSafeInteger(limit) || limit > maximumBytes || Bun.file(path).size > maximumBytes)
    throw new Error('Package archive exceeds the bounded source-package inspection limit')
  const data = gunzipSync(await Bun.file(path).bytes(), { maxOutputLength: limit })
  if (data.length % block !== 0) throw new Error('Truncated package tar blocks')
  const seen = new Set<string>()
  const regular = new Set<string>()
  let ended = false
  for (let offset = 0; offset + block <= data.length;) {
    const header = data.subarray(offset, offset + block)
    if (header.every((byte) => byte === 0)) {
      if (data.length - offset < block * 2 || data.subarray(offset).some((byte) => byte !== 0))
        throw new Error('Invalid package tar end records or trailing data')
      ended = true
      break
    }
    const checksum = octal(header.subarray(148, 156))
    let sum = 0
    for (let index = 0; index < block; index += 1)
      sum += index >= 148 && index < 156 ? 32 : header[index]!
    if (sum !== checksum) throw new Error('Invalid package tar header checksum')
    if (!['ustar\0', 'ustar '].includes(header.subarray(257, 263).toString('latin1')))
      throw new Error('Package archive must use the supported USTAR format')
    const kind = header[156] === 0 ? '0' : String.fromCharCode(header[156]!)
    if (!['0', '5'].includes(kind) || text(header.subarray(157, 257)) !== '')
      throw new Error(`Unsupported package tar member type or link: ${kind}`)
    const size = octal(header.subarray(124, 136))
    const prefix = text(header.subarray(345, 500))
    const raw = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100))
    const name = kind === '5' ? raw.replace(/\/$/, '') : raw
    if (!packagePath(name))
      throw new Error(`Package archive inventory contains an invalid path: ${raw}`)
    if (seen.has(name)) throw new Error(`Duplicate package tar member: ${name}`)
    seen.add(name)
    const start = offset + block
    const end = start + size
    const next = start + Math.ceil(size / block) * block
    if (!Number.isSafeInteger(next) || next > data.length)
      throw new Error('Truncated package tar member')
    if (data.subarray(end, next).some((byte) => byte !== 0))
      throw new Error('Invalid package tar member padding')
    if (kind === '5') {
      if (size !== 0 || !directories.has(name))
        throw new Error(`Unexpected package tar directory: ${name}`)
    } else {
      const expected = files.get(name)
      if (!expected) throw new Error(`Packed archive file inventory differs: ${name}`)
      if (
        size !== expected.bytes ||
        createHash('sha256').update(data.subarray(start, end)).digest('hex') !== expected.sha256
      )
        throw new Error(`Packed archive digest mismatch: ${name}`)
      regular.add(name)
    }
    offset = next
  }
  if (!ended) throw new Error('Package tar has no end records')
  if (regular.size !== files.size)
    throw new Error('Packed archive file inventory differs from the staged package')
}

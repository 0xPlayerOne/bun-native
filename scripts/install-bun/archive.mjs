import { gunzipSync } from 'node:zlib'
import { MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES, validatePackagePin } from './download.mjs'

/** @param {Buffer} header @param {number} start @param {number} size */
function field(header, start, size) {
  const bytes = header.subarray(start, start + size)
  const end = bytes.indexOf(0)
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('latin1')
}

/** @param {Buffer} header @param {number} start @param {number} size */
function octal(header, start, size) {
  const value = field(header, start, size).trim()
  if (!/^[0-7]{1,12}$/.test(value)) throw new Error('Invalid Bun tar numeric field')
  const number = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(number)) throw new Error('Bun tar number exceeds its bound')
  return number
}

/**
 * Parse only the three regular files in the checksum-verified npm package.
 * No archive path is ever passed to filesystem extraction or a shell utility.
 * @param {Buffer} compressed Bytes returned by downloadPinnedArchive.
 * @param {import('./download.mjs').PackagePin} pin
 * @param {string} target
 * @param {number} maximumBytes Tests/callers may reduce, never raise, the expansion bound.
 */
export function extractPinnedExecutable(
  compressed,
  pin,
  target,
  maximumBytes = MAX_UNPACKED_BYTES
) {
  validatePackagePin(pin)
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > MAX_UNPACKED_BYTES)
    throw new Error('Invalid Bun expanded byte bound')
  if (compressed.length > MAX_ARCHIVE_BYTES) throw new Error('Compressed Bun package exceeds bound')
  const match = /^(linux|darwin|win32)-(x64|arm64)$/.exec(target)
  if (!match) throw new Error('Unsupported Bun package target')
  const os = match[1]
  const cpu = match[2]
  const expectedName = `@oven/bun-${os === 'win32' ? 'windows' : os}-${cpu === 'arm64' ? 'aarch64' : cpu}`
  if (pin.name !== expectedName) throw new Error('Bun package pin does not match the host target')
  const binaryPath = `package/bin/${os === 'win32' ? 'bun.exe' : 'bun'}`
  const allowed = new Set([binaryPath, 'package/package.json', 'package/README.md'])
  /** @type {Buffer} */
  let tar
  try {
    // One output chunk sized to the pinned tar (three members, headers, padding and
    // end record) avoids concatenating ~130 MB; larger output still fails the bound.
    const chunkSize = Math.min(maximumBytes, pin.unpackedSize + 3 * 1024 + 10_240)
    tar = gunzipSync(compressed, { maxOutputLength: maximumBytes, chunkSize })
  } catch {
    throw new Error('Bun package gzip is malformed or exceeds its expanded byte bound')
  }
  if (tar.length % 512 !== 0) throw new Error('Invalid Bun tar block length')
  /** @type {Map<string, Buffer>} */
  const files = new Map()
  let total = 0
  let offset = 0
  let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every((byte) => byte === 0))
        throw new Error('Invalid Bun tar end marker')
      ended = true
      break
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    )
    if (octal(header, 148, 8) !== checksum) throw new Error('Bun tar header checksum mismatch')
    if (field(header, 257, 6) !== 'ustar' || field(header, 263, 2) !== '00')
      throw new Error('Unsupported Bun tar format')
    if (header[156] !== 0 && header[156] !== 48)
      throw new Error('Bun package contains a nonregular entry')
    const prefix = field(header, 345, 155)
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`
    if (!allowed.has(name) || files.has(name))
      throw new Error('Unexpected or duplicate Bun package path')
    const size = octal(header, 124, 12)
    if (size <= 0 || size > (name === binaryPath ? 160 * 1024 * 1024 : 16_384))
      throw new Error('Bun package member exceeds its byte bound')
    const start = offset + 512
    const end = start + size
    const paddedEnd = start + Math.ceil(size / 512) * 512
    if (paddedEnd > tar.length || !tar.subarray(end, paddedEnd).every((byte) => byte === 0))
      throw new Error('Truncated Bun package member or invalid padding')
    files.set(name, tar.subarray(start, end))
    total += size
    offset = paddedEnd
  }
  if (!ended || files.size !== 3 || total !== pin.unpackedSize)
    throw new Error('Bun package file set or unpacked size mismatch')
  const metadataFile = files.get('package/package.json')
  const executable = files.get(binaryPath)
  if (!metadataFile || !executable) throw new Error('Missing pinned Bun package files')
  let metadata
  try {
    metadata = JSON.parse(metadataFile.toString('utf8'))
  } catch {
    throw new Error('Invalid Bun package metadata')
  }
  if (
    metadata.name !== pin.name ||
    metadata.version !== pin.version ||
    !Array.isArray(metadata.os) ||
    metadata.os.length !== 1 ||
    metadata.os[0] !== os ||
    !Array.isArray(metadata.cpu) ||
    metadata.cpu.length !== 1 ||
    metadata.cpu[0] !== cpu
  )
    throw new Error('Bun package metadata does not match its pinned target/version')
  return executable
}

import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import { USTAR_BLOCK as block, ustarChecksum } from './ustar.ts'

const record = 20 * block

/**
 * Seconds since the epoch recorded for every archive member. SOURCE_DATE_EPOCH
 * (https://reproducible-builds.org/specs/source-date-epoch/) lets CI pin it to the
 * source commit time; without it, members carry the epoch itself.
 */
export function sourceDateEpoch(value = process.env['SOURCE_DATE_EPOCH']): number {
  if (value === undefined || value === '') return 0
  if (!/^\d+$/.test(value)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer')
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds) || seconds > 0o77777777777)
    throw new Error('SOURCE_DATE_EPOCH exceeds the USTAR mtime field')
  return seconds
}

function field(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'latin1')
  if (bytes.length > length) throw new Error(`Archive header field is too long: ${value}`)
  bytes.copy(header, offset)
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  field(header, offset, length, value.toString(8).padStart(length - 1, '0') + '\0')
}

/**
 * A byte-stable USTAR + gzip archive. Everything the platform tar would take from
 * the build machine (mtime, owner ids and names, directory order, gzip header
 * time/OS) is fixed, so equal members and an equal epoch always produce an
 * identical archive on every runner. Names are portable relative paths of at most
 * 100 bytes; parent directories are implied, as GNU and BSD tar accept.
 */
export function ustarGzip(
  members: { name: string; data: Uint8Array; mode: number }[],
  mtime: number
): Buffer {
  const names = members.map(({ name }) => name)
  if (new Set(names).size !== names.length) throw new Error('Duplicate archive member')
  const parts: Buffer[] = []
  for (const { name, data, mode } of [...members].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (
      name.length > 100 ||
      !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) ||
      name.split('/').some((part) => part === '.' || part === '..')
    )
      throw new Error(`Archive members must be portable relative paths: ${name}`)
    if (mode !== 0o755 && mode !== 0o644) throw new Error(`Unsupported archive mode for ${name}`)
    const header = Buffer.alloc(block)
    field(header, 0, 100, name)
    octal(header, 100, 8, mode)
    octal(header, 108, 8, 0)
    octal(header, 116, 8, 0)
    octal(header, 124, 12, data.length)
    octal(header, 136, 12, mtime)
    header.fill(0x20, 148, 156)
    header[156] = 0x30 // regular file
    field(header, 257, 6, 'ustar\0')
    field(header, 263, 2, '00')
    field(header, 148, 8, ustarChecksum(header).toString(8).padStart(6, '0') + '\0 ')
    parts.push(header, Buffer.from(data), Buffer.alloc((block - (data.length % block)) % block))
  }
  parts.push(Buffer.alloc(block * 2))
  const tar = Buffer.concat(parts)
  const padded = Buffer.concat([tar, Buffer.alloc((record - (tar.length % record)) % record)])
  const archive = gzipSync(padded, { level: 9 })
  // RFC 1952: MTIME is already zero and no name is stored; fix the zlib build's
  // OS byte so Linux, macOS and Windows produce the same header.
  if (archive[3] !== 0 || archive.readUInt32LE(4) !== 0)
    throw new Error('Unexpected gzip header metadata')
  archive[9] = 0xff
  return archive
}

/** The CI host archive: flat executable members with mode 0755. */
export function hostArchive(members: { name: string; data: Uint8Array }[], mtime: number): Buffer {
  for (const { name } of members)
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..')
      throw new Error(`Host archive members must be flat portable file names: ${name}`)
  const names = members.map(({ name }) => name)
  if (new Set(names).size !== names.length) throw new Error('Duplicate host archive member')
  return ustarGzip(
    members.map((member) => ({ ...member, mode: 0o755 })),
    mtime
  )
}

export async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { output: { type: 'string' } },
  })
  if (!values.output || !isAbsolute(values.output) || positionals.length === 0)
    throw new Error(
      'Usage: bun scripts/native/host-archive.ts --output /absolute/archive.tar.gz EXECUTABLE...'
    )
  const members = []
  for (const path of positionals) {
    if (!(await stat(path)).isFile()) throw new Error(`Host archive input is not a file: ${path}`)
    members.push({ name: basename(path), data: await readFile(path) })
  }
  await writeFile(values.output, hostArchive(members, sourceDateEpoch()), { flag: 'wx' })
}

if (import.meta.main) await main(process.argv.slice(2))

import { ArtifactError, MAX_ARCHIVE_BYTES, safeRelativePath } from './manifest.ts'
export interface TarFile {
  readonly path: string
  readonly bytes: Uint8Array
}
function octal(bytes: Uint8Array): number {
  const end = bytes.indexOf(0)
  const text = Buffer.from(end < 0 ? bytes : bytes.subarray(0, end))
    .toString('ascii')
    .trim()
  if (!/^[0-7]+$/.test(text)) throw new ArtifactError('BAD_ARCHIVE', 'Invalid tar numeric field')
  const n = parseInt(text, 8)
  if (!Number.isSafeInteger(n))
    throw new ArtifactError('BAD_ARCHIVE', 'Oversized tar numeric field')
  return n
}
function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end))
}
/** Restricted USTAR only: regular files/directories, no links, devices, PAX or sparse extensions. */
export function readTar(bytes: Uint8Array): TarFile[] {
  if (bytes.length > MAX_ARCHIVE_BYTES || bytes.length < 1024 || bytes.length % 512 !== 0)
    throw new ArtifactError('BAD_ARCHIVE', 'Invalid archive size')
  const files: TarFile[] = []
  const names = new Map<string, 'file' | 'directory'>()
  let offset = 0
  let terminated = false
  while (offset + 512 <= bytes.length) {
    const h = bytes.subarray(offset, offset + 512)
    if (h.every((n) => n === 0)) {
      if (offset + 1024 > bytes.length || !bytes.subarray(offset).every((n) => n === 0))
        throw new ArtifactError('BAD_ARCHIVE', 'Invalid tar terminator')
      terminated = true
      break
    }
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
    if (sum !== octal(h.subarray(148, 156)) || text(h.subarray(257, 263)) !== 'ustar')
      throw new ArtifactError('BAD_ARCHIVE', 'Bad USTAR header')
    const type = h[156]
    if (type !== 0 && type !== 48 && type !== 53)
      throw new ArtifactError('UNSAFE_ARCHIVE', 'Only regular files/directories are accepted')
    const prefix = text(h.subarray(345, 500))
    const name = text(h.subarray(0, 100))
    const raw = (prefix ? prefix + '/' : '') + name
    const path = safeRelativePath(type === 53 ? raw.replace(/\/$/, '') : raw)
    const key = path.toLowerCase().normalize('NFC')
    const kind = type === 53 ? 'directory' : 'file'
    if (
      names.has(key) ||
      [...names].some(
        ([n, k]) =>
          (key.startsWith(n + '/') && k === 'file') || (kind === 'file' && n.startsWith(key + '/'))
      )
    )
      throw new ArtifactError('UNSAFE_ARCHIVE', 'Conflicting archive entries')
    names.set(key, kind)
    if (names.size > 2048) throw new ArtifactError('BAD_ARCHIVE', 'Too many archive entries')
    const size = octal(h.subarray(124, 136))
    if (
      size > MAX_ARCHIVE_BYTES ||
      (kind === 'directory' && size !== 0) ||
      offset + 512 + Math.ceil(size / 512) * 512 > bytes.length
    )
      throw new ArtifactError('BAD_ARCHIVE', 'Truncated or oversized archive member')
    if (kind === 'file')
      files.push({ path, bytes: bytes.subarray(offset + 512, offset + 512 + size) })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!terminated) throw new ArtifactError('BAD_ARCHIVE', 'Missing archive terminator')
  return files
}
/** Deterministic fixture/native-probe packer; not a general-purpose tar implementation. */
export function createTar(input: readonly TarFile[]): Uint8Array<ArrayBuffer> {
  const chunks: Buffer[] = []
  for (const file of [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    safeRelativePath(file.path)
    if (Buffer.byteLength(file.path) > 99)
      throw new ArtifactError('UNSAFE_PATH', 'Probe packer paths must fit a USTAR name')
    const h = Buffer.alloc(512)
    h.write(file.path, 0, 100, 'utf8')
    const field = (n: number, start: number, len: number) =>
      h.write(n.toString(8).padStart(len - 1, '0') + '\0', start, len, 'ascii')
    field(0o644, 100, 8)
    field(0, 108, 8)
    field(0, 116, 8)
    field(file.bytes.length, 124, 12)
    field(0, 136, 12)
    h.fill(32, 148, 156)
    h[156] = 48
    h.write('ustar\0', 257, 6, 'ascii')
    h.write('00', 263, 2, 'ascii')
    const checksum = h.reduce((sum, n) => sum + n, 0)
    h.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    chunks.push(h, Buffer.from(file.bytes), Buffer.alloc((512 - (file.bytes.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  const result = Buffer.concat(chunks)
  if (result.length > MAX_ARCHIVE_BYTES)
    throw new ArtifactError('BAD_ARCHIVE', 'Probe archive exceeds size limit')
  readTar(result)
  return result
}

/** Contributor packaging of an already built runtime. No native compiler or browser download. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, opendir, readFile, readlink, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  cefError,
  cefIdentity,
  parseCefManifest,
  type CefMember,
  type CefRuntimeIdentity,
  type CefRuntimeManifest,
} from './cef-manifest.ts'
import { validateCefDirectory } from './cef-cache.ts'
import { writeCefArchive } from './cef-archive-output.ts'
import { safeRelativePath } from './manifest.ts'
function number(value: number, size: number): Buffer {
  const text = value.toString(8)
  if (text.length > size - 1) cefError('BAD_ARCHIVE', 'USTAR integer exceeds header size')
  return Buffer.from(text.padStart(size - 1, '0') + '\0')
}
export function runtimeTarHeader(member: CefMember): Buffer {
  safeRelativePath(member.path)
  const parts = member.path.split('/')
  let name = parts.pop()!,
    prefix = parts.join('/')
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
    cefError('BAD_ARCHIVE', 'Runtime path cannot be represented by the USTAR profile')
  if (Buffer.byteLength(member.path) <= 100) {
    name = member.path
    prefix = ''
  }
  const b = Buffer.alloc(512)
  b.write(name, 0, 100, 'utf8')
  number(member.type === 'symlink' ? 0o777 : member.mode, 8).copy(b, 100)
  number(0, 8).copy(b, 108)
  number(0, 8).copy(b, 116)
  number(member.type === 'file' ? member.size : 0, 12).copy(b, 124)
  number(0, 12).copy(b, 136)
  b.fill(32, 148, 156)
  b[156] = member.type === 'file' ? 48 : member.type === 'directory' ? 53 : 50
  if (member.type === 'symlink') {
    if (Buffer.byteLength(member.target) > 100)
      cefError('BAD_ARCHIVE', 'Runtime link exceeds USTAR field')
    b.write(member.target, 157, 100, 'utf8')
  }
  b.write('ustar\0', 257, 6, 'ascii')
  b.write('00', 263, 2, 'ascii')
  b.write(prefix, 345, 155, 'utf8')
  const sum = b.reduce((a, v) => a + v, 0)
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return b
}
export async function packageCefRuntime(options: {
  readonly directory: string
  readonly output: string
  readonly url: string
  readonly identity: CefRuntimeIdentity
  readonly layout: CefRuntimeManifest['layout']
  readonly notices: readonly string[]
}): Promise<CefRuntimeManifest> {
  const raw = resolve(options.directory)
  if ((await lstat(raw)).isSymbolicLink())
    cefError('UNSAFE_PATH', 'Packaged runtime root must not be a link')
  const root = await realpath(raw),
    output = join(
      await realpath(dirname(resolve(options.output))),
      relative(dirname(resolve(options.output)), resolve(options.output))
    )
  const delta = relative(root, output)
  if (
    delta === '' ||
    (!isAbsolute(delta) &&
      delta !== '..' &&
      !delta.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
  )
    cefError('UNSAFE_PATH', 'Runtime archive cannot include itself')
  const identity = cefIdentity(options.identity),
    members: CefMember[] = []
  const executables = new Set([
    options.layout.executable,
    options.layout.bun,
    ...options.layout.helpers,
  ])
  async function visit(prefix: string) {
    const entries = []
    for await (const e of await opendir(join(root, prefix))) entries.push(e.name)
    entries.sort()
    for (const name of entries) {
      const path = prefix ? prefix + '/' + name : name
      safeRelativePath(path)
      if (/(?:^|\/)[^/]*\.dSYM(?:\/|$)|\.(?:pdb|debug)$/i.test(path))
        cefError(
          'BAD_MANIFEST',
          'This runtime profile excludes standalone debug symbols; retain them separately'
        )
      const full = join(root, path),
        info = await lstat(full)
      if (members.length >= 20000) cefError('BAD_MANIFEST', 'Too many native runtime members')
      if (info.isSymbolicLink())
        members.push({ path, type: 'symlink', target: await readlink(full) })
      else if (info.isDirectory()) {
        members.push({
          path,
          type: 'directory',
          mode: process.platform === 'win32' ? 0o755 : info.mode & 0o777,
        })
        await visit(path)
      } else if (info.isFile() && info.nlink === 1) {
        const h = createHash('sha256')
        for await (const chunk of createReadStream(full)) h.update(chunk)
        members.push({
          path,
          type: 'file',
          mode:
            process.platform === 'win32'
              ? executables.has(path)
                ? 0o755
                : 0o644
              : info.mode & 0o777,
          size: info.size,
          sha256: h.digest('hex'),
        })
      } else cefError('UNSAFE_PATH', 'Unsupported or hard-linked native runtime member')
    }
  }
  await visit('')
  const tarBytes = members.reduce(
    (sum, f) => sum + 512 + (f.type === 'file' ? Math.ceil(f.size / 512) * 512 : 0),
    1024
  )
  const provisional = parseCefManifest({
    schema: 2,
    identity,
    archive: { url: options.url, size: 1, sha256: '0'.repeat(64), tarBytes, format: 'ustar-gzip' },
    members,
    layout: options.layout,
    notices: options.notices,
    locales: 'all',
    debugSymbols: false,
  })
  const deadline = AbortSignal.timeout(600000)
  await validateCefDirectory(root, provisional, deadline)
  // Production packages cannot obtain a development-origin grant from an environment variable.
  const runtime = JSON.parse(
    await readFile(join(root, options.layout.resources, 'runtime.json'), 'utf8')
  )
  if (
    runtime.schema !== 1 ||
    runtime.protocol !== identity.abi ||
    runtime.bun_version !== identity.bun ||
    runtime.cef_version !== identity.cef ||
    runtime.development_origin !== undefined
  )
    cefError(
      'IDENTITY_MISMATCH',
      'Runtime config differs from packaged identity or enables development origin'
    )
  async function* stream() {
    for (const f of members) {
      yield runtimeTarHeader(f)
      if (f.type === 'file') {
        let total = 0
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(join(root, f.path), { highWaterMark: 65536 })) {
          total += chunk.length
          hash.update(chunk)
          if (total > f.size) cefError('INTEGRITY_ERROR', 'Runtime grew while packing')
          yield chunk
        }
        if (total !== f.size || hash.digest('hex') !== f.sha256)
          cefError('INTEGRITY_ERROR', 'Runtime changed while packing')
        const pad = (512 - (f.size % 512)) % 512
        if (pad) yield Buffer.alloc(pad)
      }
    }
    yield Buffer.alloc(1024)
  }
  let owned = false,
    completed = false
  const destination = createWriteStream(output, { flags: 'wx', mode: 0o600 })
  destination.once('open', () => {
    owned = true
  })
  try {
    const archive = await writeCefArchive(stream(), destination, deadline)
    await validateCefDirectory(root, provisional, deadline)
    const written = await lstat(output)
    if (!written.isFile() || written.isSymbolicLink() || written.size !== archive.size)
      cefError('INTEGRITY_ERROR', 'Completed runtime archive has an unexpected type or length')
    const result = parseCefManifest({
      ...provisional,
      archive: {
        ...provisional.archive,
        size: archive.size,
        sha256: archive.sha256,
      },
    })
    completed = true
    return result
  } finally {
    if (owned && !completed) await rm(output, { force: true })
  }
}

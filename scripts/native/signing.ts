import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { lstat, open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileDigest, type FileDigest } from './artifact.ts'
import { commandRunner, type Command, type Runner } from './process.ts'
import { parseUpdateManifest, type UpdateManifest } from './update-manifest.ts'

/**
 * OS code signing for `native build` outputs and self-contained update bundles (#249).
 *
 * macOS uses `codesign` with the hardened runtime and a secure timestamp; Windows uses
 * `signtool` with SHA-256 digests and an RFC 3161 timestamp. Identities are provisioned
 * by the caller (a keychain identity hash or a certificate-store thumbprint), so this
 * module never reads key material. Every command goes through a `Runner`, which lets the
 * argument construction and manifest rewriting be tested where the tools do not exist.
 */
export type { Command, Runner } from './process.ts'

export const runCommand: Runner = commandRunner(900_000)

export type SigningIdentity =
  | {
      platform: 'darwin'
      /** A keychain identity's SHA-1 hash or name, or `-` for an ad-hoc signature. */
      identity: string
      keychain?: string
      /** Entitlements for Bun executables; the GPUI host is signed without any. */
      entitlements: string
      timestamp: boolean
    }
  | {
      platform: 'win32'
      signtool: string
      /** A certificate thumbprint in CurrentUser\My, or a signtool dlib (e.g. Trusted Signing). */
      certificate: { thumbprint: string } | { dlib: string; metadata: string }
      /** An RFC 3161 timestamp server, or undefined for an untimestamped signature. */
      timestampUrl: string | undefined
    }

export type SignatureRecord = {
  file: string
  unsigned: FileDigest
  signed: FileDigest
  verification: SignatureVerification
}

export type SignatureVerification = {
  file: string
  kind: 'apple-codesign' | 'windows-authenticode'
  /** Certificate chain, leaf first. Empty for an ad-hoc signature. */
  authority: string[]
  teamIdentifier?: string
  timestamp?: string
  hardenedRuntime?: boolean
}

export const entitlementsPath = resolve(import.meta.dir, 'entitlements.plist')
export const defaultTimestampUrl = 'http://timestamp.digicert.com'

type NativeKind = 'mach-o' | 'pe' | 'elf'

/** Identify a native executable by its header; scripts and data are not signed here. */
export async function nativeKind(path: string): Promise<NativeKind | undefined> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(512)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const bytes = header.subarray(0, bytesRead)
    if (bytes.length < 4) return undefined
    const magic = bytes.readUInt32BE(0)
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic))
      return 'mach-o'
    if (magic === 0x7f454c46) return 'elf'
    if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 64) {
      const offset = bytes.readUInt32LE(60)
      const signature = Buffer.alloc(4)
      await file.read(signature, 0, 4, offset)
      if (signature.equals(Buffer.from('PE\0\0', 'latin1'))) return 'pe'
    }
    return undefined
  } finally {
    await file.close()
  }
}

const expectedKind: Record<SigningIdentity['platform'], NativeKind> = {
  darwin: 'mach-o',
  win32: 'pe',
}

/** Every native executable below `directory`, as sorted portable relative paths. */
async function nativeExecutables(
  directory: string,
  exclude: (path: string) => boolean = () => false
): Promise<{ path: string; kind: NativeKind }[]> {
  const found: { path: string; kind: NativeKind }[] = []
  const walk = async (prefix: string) => {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (exclude(path)) continue
      if (entry.isSymbolicLink())
        throw new Error(`Refusing to sign through a symbolic link: ${path}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const kind = await nativeKind(join(directory, path))
        if (kind) found.push({ path, kind })
      }
    }
  }
  await walk('')
  return found.sort((a, b) => (a.path < b.path ? -1 : 1))
}

function fail(command: string[], result: Command, what: string): never {
  throw new Error(
    `${what} failed (${result.exitCode}): ${command.join(' ')}\n${result.stdout}${result.stderr}`
  )
}

/** Pause before retry N is N times this; tests set it to 0. */
export const retry = { delayMs: 5_000 }

/** Timestamp servers fail transiently; a failed signtool or codesign run leaves the file as it was. */
function withRetries(runner: Runner, command: string[], attempts: number, what: string): Command {
  let result: Command | undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = runner(command)
    if (result.exitCode === 0) return result
    if (attempt < attempts && retry.delayMs > 0) Bun.sleepSync(retry.delayMs * attempt)
  }
  fail(command, result!, what)
}

function signCommand(identity: SigningIdentity, path: string, entitled: boolean): string[] {
  if (identity.platform === 'darwin')
    return [
      'codesign',
      '--force',
      '--sign',
      identity.identity,
      '--options',
      'runtime',
      identity.timestamp ? '--timestamp' : '--timestamp=none',
      ...(identity.keychain ? ['--keychain', identity.keychain] : []),
      ...(entitled ? ['--entitlements', identity.entitlements] : []),
      path,
    ]
  const certificate =
    'thumbprint' in identity.certificate
      ? ['/sha1', identity.certificate.thumbprint, '/s', 'My']
      : ['/dlib', identity.certificate.dlib, '/dmdf', identity.certificate.metadata]
  return [
    identity.signtool,
    'sign',
    '/v',
    '/fd',
    'sha256',
    ...certificate,
    ...(identity.timestampUrl ? ['/tr', identity.timestampUrl, '/td', 'sha256'] : []),
    path,
  ]
}

/** Parse `codesign --display --verbose=4` (written to stderr). */
export function parseCodesignDisplay(text: string): Omit<SignatureVerification, 'file' | 'kind'> {
  const values = (key: string) =>
    text
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${key}=`))
      .map((line) => line.slice(key.length + 1))
  const flags = text.match(/flags=0x[0-9a-f]+\(([^)]*)\)/)?.[1] ?? ''
  const team = values('TeamIdentifier')[0]
  const timestamp = values('Timestamp')[0]
  return {
    authority: values('Authority'),
    ...(team && team !== 'not set' ? { teamIdentifier: team } : {}),
    ...(timestamp ? { timestamp } : {}),
    hardenedRuntime: flags.split(',').includes('runtime'),
  }
}

/** Parse `signtool verify /pa /v`: the chain's "Issued to" names and the timestamp line. */
export function parseSigntoolVerify(text: string): Omit<SignatureVerification, 'file' | 'kind'> {
  // Hosted windows-2022 signtool ends lines with CR CR LF; a bare CR would defeat `.+$`.
  const lines = text.split(/\r*\n/).map((line) => line.replace(/\r+$/, ''))
  const start = lines.findIndex((line) => /Signing Certificate Chain:/.test(line))
  const end = lines.findIndex((line, index) => index > start && /timestamp/i.test(line))
  const chain = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => line.match(/Issued to:\s*(.+)$/)?.[1]?.trim())
    .filter((name): name is string => !!name)
  const timestamp = text.match(/The signature is timestamped:\s*(.+)/)?.[1]?.trim()
  // signtool prints the chain root first; report the leaf first like codesign.
  return { authority: start === -1 ? [] : chain.reverse(), ...(timestamp ? { timestamp } : {}) }
}

/** Check one file's signature on this platform and describe it. Throws when it is invalid. */
export function verifySignature(
  platform: SigningIdentity['platform'],
  path: string,
  runner: Runner,
  options: { signtool?: string; requireTimestamp?: boolean } = {}
): SignatureVerification {
  if (platform === 'darwin') {
    const check = ['codesign', '--verify', '--strict', '--verbose=2', path]
    const verified = runner(check)
    if (verified.exitCode !== 0) fail(check, verified, 'Signature verification')
    const show = ['codesign', '--display', '--verbose=4', path]
    const shown = runner(show)
    if (shown.exitCode !== 0) fail(show, shown, 'Signature display')
    const details = parseCodesignDisplay(shown.stderr + shown.stdout)
    if (!details.hardenedRuntime) throw new Error(`${path} is not signed with the hardened runtime`)
    if (options.requireTimestamp && !details.timestamp)
      throw new Error(`${path} has no secure timestamp`)
    return { file: path, kind: 'apple-codesign', ...details }
  }
  const check = [options.signtool ?? 'signtool', 'verify', '/pa', '/v', path]
  const verified = runner(check)
  if (verified.exitCode !== 0) fail(check, verified, 'Signature verification')
  // signtool's verbose chain can reach either stream; parse both and keep them on failure.
  const output = `${verified.stdout}\n${verified.stderr}`
  const details = parseSigntoolVerify(output)
  if (details.authority.length === 0)
    throw new Error(`${path} names no signing certificate\n${output.trim()}`)
  if (options.requireTimestamp && !details.timestamp)
    throw new Error(`${path} has no RFC 3161 timestamp`)
  return { file: path, kind: 'windows-authenticode', ...details }
}

/**
 * The application bundle whose main executable `path` is, on macOS. codesign seals a
 * bundle's Info.plist and resources only when it is given the bundle, so such an
 * executable is signed and verified through its bundle.
 */
export function enclosingBundle(path: string): string | undefined {
  const match = /^(.+\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(path)
  return match?.[1]
}

/**
 * Sign one file in place, then verify it. `entitled` adds the Bun entitlements on macOS.
 * On macOS the main executable of an application bundle is signed as that bundle.
 */
export async function signFile(
  identity: SigningIdentity,
  path: string,
  runner: Runner,
  entitled = false
): Promise<{ unsigned: FileDigest; signed: FileDigest; verification: SignatureVerification }> {
  const code = (identity.platform === 'darwin' && enclosingBundle(path)) || path
  const unsigned = await fileDigest(path)
  const timestamped =
    identity.platform === 'darwin'
      ? identity.timestamp && identity.identity !== '-'
      : !!identity.timestampUrl
  withRetries(runner, signCommand(identity, code, entitled), timestamped ? 3 : 1, 'Code signing')
  const verification = verifySignature(identity.platform, code, runner, {
    requireTimestamp: timestamped,
    ...(identity.platform === 'win32' ? { signtool: identity.signtool } : {}),
  })
  return { unsigned, signed: await fileDigest(path), verification }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, text, { flag: 'wx' })
  await rename(temporary, path)
}

type BuildManifest = {
  target?: { os?: unknown }
  application?: { file?: unknown; bytes?: unknown; sha256?: unknown }
  host?: { file?: unknown; bytes?: unknown; sha256?: unknown }
  reproducibility?: { deterministic?: unknown; [key: string]: unknown }
  verification?: { signing?: unknown; [key: string]: unknown }
  [key: string]: unknown
}

export type SigningSummary = {
  kind: SignatureVerification['kind']
  /** The leaf certificate's name, or `ad-hoc`. */
  identity: string
  teamIdentifier?: string
  timestamped: boolean
  files: SignatureRecord[]
}

function summary(identity: SigningIdentity, files: SignatureRecord[]): SigningSummary {
  const first = files[0]!.verification
  return {
    kind: first.kind,
    identity: first.authority[0] ?? (identity.platform === 'darwin' ? 'ad-hoc' : 'unknown'),
    ...(first.teamIdentifier ? { teamIdentifier: first.teamIdentifier } : {}),
    timestamped: files.every((file) => !!file.verification.timestamp),
    files,
  }
}

/**
 * Sign every native executable of a `native build` output and rewrite its build manifest
 * with the signed digests, so the update manifest, installer and verifying launcher keep
 * agreeing with the files they hash. The unsigned digests stay in the signing record, which
 * is what reproducibility comparisons use: signatures and timestamps are never reproducible.
 */
export async function signBuild(
  directory: string,
  identity: SigningIdentity,
  runner: Runner = runCommand
): Promise<SigningSummary> {
  const root = resolve(directory)
  const manifestPath = join(root, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifest
  if (manifest?.target?.os !== identity.platform)
    throw new Error(
      `A ${String(manifest?.target?.os)} build cannot be signed with ${identity.platform} tools`
    )
  if (manifest.verification?.signing !== 'unsigned')
    throw new Error('The build is already signed; sign a fresh native build output')
  const parts = { application: manifest.application, host: manifest.host }
  for (const [name, part] of Object.entries(parts)) {
    if (typeof part?.file !== 'string') throw new Error(`The build manifest names no ${name}`)
    const digest = await fileDigest(join(root, part.file))
    if (digest.sha256 !== part.sha256 || digest.bytes !== part.bytes)
      throw new Error(`${part.file} does not match the build manifest; rebuild before signing`)
  }
  const natives = await nativeExecutables(root)
  for (const { path, kind } of natives)
    if (kind !== expectedKind[identity.platform])
      throw new Error(`${path} is a ${kind} executable, not a ${identity.platform} one`)
  const paths = natives.map(({ path }) => path)
  for (const part of Object.values(parts))
    if (!paths.includes(part!.file as string))
      throw new Error(`${String(part!.file)} is not a native executable`)
  const files: SignatureRecord[] = []
  for (const path of paths) {
    // Bun executables need the JavaScriptCore entitlements; the Rust host needs none.
    const result = await signFile(identity, join(root, path), runner, path !== parts.host!.file)
    files.push({ ...result, verification: { ...result.verification, file: path }, file: path })
  }
  const signedDigest = (file: unknown) => files.find((record) => record.file === file)!.signed
  const deterministic = Array.isArray(manifest.reproducibility?.deterministic)
    ? (manifest.reproducibility.deterministic as string[])
    : []
  const signed = summary(identity, files)
  const rewritten: BuildManifest = {
    ...manifest,
    application: { ...manifest.application, ...signedDigest(parts.application!.file) },
    host: { ...manifest.host, ...signedDigest(parts.host!.file) },
    ...(manifest.reproducibility
      ? {
          reproducibility: {
            ...manifest.reproducibility,
            // Signed bytes and the manifest that records them carry signatures and
            // timestamps; compare `verification.signing.files[].unsigned` instead.
            deterministic: deterministic.filter(
              (path) => path !== 'manifest.json' && !paths.includes(path)
            ),
            signed: [...paths, 'manifest.json'],
          },
        }
      : {}),
    verification: { ...manifest.verification, signing: signed },
  }
  await writeAtomically(manifestPath, JSON.stringify(rewritten, null, 2) + '\n')
  return signed
}

async function checkPayload(directory: string, manifest: UpdateManifest): Promise<void> {
  for (const [path, expected] of Object.entries(manifest.files)) {
    const actual = await fileDigest(join(directory, 'payload', path))
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new Error(`payload/${path} does not match update.json`)
  }
}

/**
 * Sign the compiled updater and verifying launcher of a `bundle --self-contained`
 * directory. The payload is described by the signed update manifest and must already be
 * signed (`signBuild` before `manifest`); it is checked, never modified.
 */
export async function signBundle(
  directory: string,
  identity: SigningIdentity,
  runner: Runner = runCommand
): Promise<SigningSummary> {
  const root = resolve(directory)
  const manifest = parseUpdateManifest(
    JSON.parse(await readFile(join(root, 'update.json'), 'utf8'))
  )
  if (manifest.target.os !== identity.platform)
    throw new Error(
      `A ${manifest.target.os} bundle cannot be signed with ${identity.platform} tools`
    )
  await checkPayload(root, manifest)
  const exe = identity.platform === 'win32' ? '.exe' : ''
  const tools = [`bun-native-update${exe}`, `launcher${exe}`]
  const natives = await nativeExecutables(root, (path) => path === 'payload')
  const paths = natives.map(({ path }) => path)
  for (const tool of tools)
    if (!paths.includes(tool)) throw new Error(`The bundle has no ${tool}; use --self-contained`)
  for (const { path, kind } of natives)
    if (kind !== expectedKind[identity.platform])
      throw new Error(`${path} is a ${kind} executable, not a ${identity.platform} one`)
  const files: SignatureRecord[] = []
  for (const path of paths) {
    const result = await signFile(identity, join(root, path), runner, true)
    files.push({ ...result, verification: { ...result.verification, file: path }, file: path })
  }
  await checkPayload(root, manifest)
  const signed = summary(identity, files)
  await writeFile(join(root, 'signing.json'), JSON.stringify(signed, null, 2) + '\n', {
    flag: 'wx',
  })
  const readme = join(root, 'README.txt')
  if (existsSync(readme))
    await writeFile(
      readme,
      `The bundled updater and launcher are code-signed by ${signed.identity}; see signing.json.\n`,
      { flag: 'a' }
    )
  return signed
}

/** Verify every native executable below a directory (or one file). Throws on the first invalid one. */
export async function verifyTree(
  path: string,
  platform: SigningIdentity['platform'],
  runner: Runner = runCommand,
  options: { signtool?: string } = {}
): Promise<SignatureVerification[]> {
  const target = resolve(path)
  const files = (await lstat(target)).isDirectory()
    ? (await nativeExecutables(target)).map((entry) => ({
        absolute: join(target, entry.path),
        name: entry.path,
      }))
    : [{ absolute: target, name: target.split(sep).pop()! }]
  if (files.length === 0) throw new Error(`No native executables to verify in ${path}`)
  return files.map(({ absolute, name }) => ({
    ...verifySignature(
      platform,
      (platform === 'darwin' && enclosingBundle(absolute)) || absolute,
      runner,
      options
    ),
    file: name,
  }))
}

/** The newest Windows SDK signtool for this machine's architecture, or one on PATH. */
export function findSigntool(env: Record<string, string | undefined> = process.env): string {
  if (env['SIGNTOOL']) return env['SIGNTOOL']
  const base = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits/10/bin')
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const left = a.split('.').map(Number)
        const right = b.split('.').map(Number)
        for (let index = 0; index < 4; index++)
          if (left[index] !== right[index]) return right[index]! - left[index]!
        return 0
      })
    for (const version of versions) {
      const candidate = join(base, version, architecture, 'signtool.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  const onPath = Bun.which('signtool')
  if (onPath) return onPath
  throw new Error('signtool.exe was not found; install the Windows SDK or set SIGNTOOL')
}

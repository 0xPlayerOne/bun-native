import { existsSync } from 'node:fs'
import { cp, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { fileDigest, type FileDigest } from './artifact.ts'
import { sourceDateEpoch, ustarGzip } from './host-archive.ts'
import { parseUpdateManifest, type UpdateManifest } from './update-manifest.ts'
import { runCommand, signFile, type Runner, type SigningIdentity } from './signing.ts'

/**
 * Installer images for a `bundle --self-contained` directory (#249): a macOS `.dmg`, a
 * Windows `.zip` and a Linux or macOS `.tar.gz`. Each holds the bundle unchanged (update
 * manifest, signature, payload, compiled updater, verifying launcher and key set) plus an
 * install script that runs the bundled updater, so the update manifest and launcher
 * contract in docs/updates.md is exactly the one an installer uses.
 */
export type InstallerFormat = 'dmg' | 'zip' | 'tar.gz'

const namePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

export function installerFormats(os: string): InstallerFormat[] {
  if (os === 'darwin') return ['dmg', 'tar.gz']
  if (os === 'win32') return ['zip']
  if (os === 'linux') return ['tar.gz']
  return []
}

function shellScript(manifest: UpdateManifest, name: string): string {
  const darwin = manifest.target.os === 'darwin'
  const root = darwin
    ? `$HOME/Library/Application Support/${manifest.product}`
    : `\${XDG_DATA_HOME:-$HOME/.local/share}/${manifest.product}`
  const menu = darwin ? '$HOME/Applications' : '${XDG_DATA_HOME:-$HOME/.local/share}/applications'
  return [
    '#!/bin/sh',
    `# Installs ${manifest.product} ${manifest.version} for the current user with the bundled updater.`,
    '# Usage: install.sh [INSTALL_DIR] [MENU_DIR]',
    'set -eu',
    'here=$(cd "$(dirname "$0")" && pwd)',
    `root=\${1:-"${root}"}`,
    `menu=\${2:-"${menu}"}`,
    `"$here/bun-native-update" install "$here/update.json" --payload "$here/payload" --root "$root" ${trust(manifest, '"$here/keys.json"')}`,
    `"$here/bun-native-update" integrate --root "$root" --name '${name}' --applications "$menu" --verified-launcher "$here/launcher"`,
    '',
  ].join('\n')
}

function powershellScript(manifest: UpdateManifest, name: string): string {
  return [
    `# Installs ${manifest.product} ${manifest.version} for the current user with the bundled updater.`,
    'param(',
    `  [string]$Root = (Join-Path $env:LOCALAPPDATA 'Programs\\${manifest.product}'),`,
    "  [string]$Menu = (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')",
    ')',
    "$ErrorActionPreference = 'Stop'",
    "$tool = Join-Path $PSScriptRoot 'bun-native-update.exe'",
    `& $tool install (Join-Path $PSScriptRoot 'update.json') --payload (Join-Path $PSScriptRoot 'payload') --root $Root ${trust(manifest, "(Join-Path $PSScriptRoot 'keys.json')")}`,
    'if ($LASTEXITCODE -ne 0) { throw "Installation failed ($LASTEXITCODE)" }',
    `& $tool integrate --root $Root --name '${name}' --applications $Menu --verified-launcher (Join-Path $PSScriptRoot 'launcher.exe')`,
    'if ($LASTEXITCODE -ne 0) { throw "Menu integration failed ($LASTEXITCODE)" }',
    '',
  ].join('\r\n')
}

function trust(manifest: UpdateManifest, keySet: string): string {
  return manifest.trust === 'unsigned-experimental'
    ? '--unsigned-experimental'
    : `--key-set ${keySet}`
}

/** Check that a directory is a complete self-contained bundle and return its manifest. */
async function readBundle(bundle: string): Promise<UpdateManifest> {
  const manifest = parseUpdateManifest(
    JSON.parse(await readFile(join(bundle, 'update.json'), 'utf8'))
  )
  const exe = manifest.target.os === 'win32' ? '.exe' : ''
  const required = [`bun-native-update${exe}`, `launcher${exe}`]
  if (manifest.trust === 'ed25519') required.push('update.json.sig', 'keys.json')
  for (const file of required)
    if (!existsSync(join(bundle, file)))
      throw new Error(
        `The bundle has no ${file}; create it with bundle --self-contained${manifest.trust === 'ed25519' ? ' --key-set' : ''}`
      )
  for (const [path, expected] of Object.entries(manifest.files)) {
    const actual = await fileDigest(join(bundle, 'payload', path))
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new Error(`payload/${path} does not match update.json`)
  }
  return manifest
}

async function members(
  root: string,
  prefix: string
): Promise<{ name: string; data: Buffer; mode: number }[]> {
  const found: { name: string; data: Buffer; mode: number }[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await members(root, path)))
    else if (entry.isFile()) {
      const stats = await lstat(join(root, path))
      found.push({
        name: path,
        data: await readFile(join(root, path)),
        mode: process.platform !== 'win32' && stats.mode & 0o100 ? 0o755 : 0o644,
      })
    } else throw new Error(`Installers hold only regular files: ${path}`)
  }
  return found
}

/**
 * A deterministic ZIP (stored names, DEFLATE, fixed 1980-01-01 times, Unix modes). Only
 * the features `Expand-Archive`, Explorer and `unzip` need; no ZIP64, so under 4 GiB.
 */
export function zipArchive(entries: { name: string; data: Uint8Array; mode: number }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const { name, data, mode } of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const fileName = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(0, 10) // 00:00
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, spec 2.0
    local.copy(central, 6, 4, 26) // version needed through uncompressed size
    central.writeUInt16LE(fileName.length, 28)
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, fileName, compressed)
    centrals.push(central, fileName)
    offset += local.length + fileName.length + compressed.length
    if (offset > 0xffffffff) throw new Error('Installer archives above 4 GiB need ZIP64')
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

export type InstallerRecord = {
  file: string
  format: InstallerFormat
  product: string
  version: string
  target: UpdateManifest['target']
  trust: UpdateManifest['trust']
  digest: FileDigest
  scriptSignature?: string
  imageSignature?: string
}

/**
 * Write `<bundle name>.<format>` into `out`. With `signing`, the Windows install script and
 * the macOS disk image are signed and verified too (bundle executables are signed earlier
 * with `signBundle`).
 */
export async function createInstaller(
  bundle: string,
  out: string,
  options: {
    format: InstallerFormat
    name: string
    signing?: SigningIdentity
    runner?: Runner
  }
): Promise<InstallerRecord> {
  const source = resolve(bundle)
  const runner = options.runner ?? runCommand
  if (!namePattern.test(options.name))
    throw new Error('Application names use letters, digits, spaces, ., _ and -')
  const manifest = await readBundle(source)
  if (!installerFormats(manifest.target.os).includes(options.format))
    throw new Error(`A ${options.format} installer is not built for ${manifest.target.os}`)
  if (options.signing && options.signing.platform !== manifest.target.os)
    throw new Error(
      `A ${manifest.target.os} installer cannot be signed with ${options.signing.platform} tools`
    )
  const name = basename(source)
  const file = join(resolve(out), `${name}.${options.format}`)
  if (existsSync(file)) throw new Error(`${file} already exists`)
  const staging = await mkdtemp(join(resolve(out), '.installer-'))
  try {
    const content = join(staging, name)
    await cp(source, content, { recursive: true, errorOnExist: true, force: false })
    let scriptSignature: string | undefined
    if (manifest.target.os === 'win32') {
      const script = join(content, 'install.ps1')
      await writeFile(script, powershellScript(manifest, options.name), { flag: 'wx' })
      if (options.signing) {
        const signed = await signFile(options.signing, script, runner)
        scriptSignature = signed.verification.authority[0]
      }
    } else
      await writeFile(join(content, 'install.sh'), shellScript(manifest, options.name), {
        flag: 'wx',
        mode: 0o755,
      })
    let imageSignature: string | undefined
    if (options.format === 'dmg') {
      if (process.platform !== 'darwin') throw new Error('Disk images are built on macOS')
      // hdiutil intermittently reports "Resource busy" on hosted runners; retry.
      let created = { exitCode: 1, stdout: '', stderr: '' }
      for (let attempt = 0; attempt < 3 && created.exitCode !== 0; attempt++) {
        if (attempt > 0) await rm(file, { force: true })
        created = runner([
          'hdiutil',
          'create',
          '-volname',
          options.name,
          '-srcfolder',
          staging,
          '-fs',
          'HFS+',
          '-format',
          'UDZO',
          file,
        ])
      }
      if (created.exitCode !== 0)
        throw new Error(`hdiutil create failed\n${created.stdout}${created.stderr}`)
      if (options.signing?.platform === 'darwin') {
        const identity = options.signing
        const command = [
          'codesign',
          '--force',
          '--sign',
          identity.identity,
          identity.timestamp && identity.identity !== '-' ? '--timestamp' : '--timestamp=none',
          ...(identity.keychain ? ['--keychain', identity.keychain] : []),
          file,
        ]
        const signed = runner(command)
        if (signed.exitCode !== 0)
          throw new Error(`Signing the disk image failed\n${signed.stdout}${signed.stderr}`)
        const verified = runner(['codesign', '--verify', '--strict', '--verbose=2', file])
        if (verified.exitCode !== 0)
          throw new Error(`The disk image signature is invalid\n${verified.stderr}`)
        const shown = runner(['codesign', '--display', '--verbose=4', file])
        imageSignature =
          (shown.stderr + shown.stdout).match(/^Authority=(.+)$/m)?.[1] ??
          (identity.identity === '-' ? 'ad-hoc' : identity.identity)
      }
    } else {
      const entries = await members(staging, name)
      await writeFile(
        file,
        options.format === 'zip' ? zipArchive(entries) : ustarGzip(entries, sourceDateEpoch()),
        { flag: 'wx' }
      )
    }
    return {
      file,
      format: options.format,
      product: manifest.product,
      version: manifest.version,
      target: manifest.target,
      trust: manifest.trust,
      digest: await fileDigest(file),
      ...(scriptSignature ? { scriptSignature } : {}),
      ...(imageSignature ? { imageSignature } : {}),
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

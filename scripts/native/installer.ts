import { copyFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readState, recordIntegration } from './installation.ts'
import { fileDigest } from './artifact.ts'
import { UpdateError, parseUpdateManifest, type UpdateManifest } from './update-manifest.ts'

/**
 * Experimental, unsigned per-user desktop integration for an installation root:
 * a launcher that follows the committed `current` pointer (or a compiled verifying
 * launcher), plus a Linux .desktop
 * entry, a macOS .app wrapper or a Windows Start-menu command file.
 */
export type Platform = 'linux' | 'darwin' | 'win32'

export type Integration = {
  platform: Platform
  /** Display name, e.g. "Example App". */
  name: string
  /** Where the menu entry goes: XDG applications, ~/Applications or the Start-menu Programs folder. */
  applications: string
  /**
   * A verifying launcher executable from `release-update.ts launcher`, built for this
   * platform. It is installed as `bin/<product>` in place of the pointer script, so every
   * start re-hashes the current release and advances a pending health check.
   */
  verifiedLauncher?: string
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

/**
 * Paths are embedded in shell, .desktop, plist and cmd text, so only plain characters are
 * allowed. `~` is accepted because Windows 8.3 short names (such as `C:\Users\RUNNER~1`, which
 * `%TEMP%` often uses) contain it, and it is literal in every embedding: single-quoted shell,
 * a quoted .desktop Exec argument, plist text and a quoted cmd `set` or `call`.
 */
function plainPath(path: string): string {
  if (!isAbsolute(path) || !/^[A-Za-z0-9 _./:\\~-]+$/.test(path))
    throw new UpdateError('state', `Unsupported characters in installation path: ${path}`)
  return path
}

export function launcherScript(platform: Platform, root: string): string {
  const base = plainPath(resolve(root))
  if (platform === 'win32')
    return [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `set "BUN_NATIVE_ROOT=${base}"`,
      'set "release="',
      'set /p release=<"%BUN_NATIVE_ROOT%\\current"',
      'if not defined release exit /b 1',
      // Validate with delayed expansion, which never re-parses the pointer text: first strip
      // every allowed character (case-insensitively), and only if nothing is left is the
      // value safe to compare. It must be exactly versions/<name>, not only dots.
      'setlocal EnableDelayedExpansion',
      'set "left=!release!"',
      'for %%c in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 . - /) do if defined left set "left=!left:%%c=!"',
      'if defined left exit /b 1',
      'if not "!release:~0,9!"=="versions/" exit /b 1',
      'set "name=!release:~9!"',
      'if not defined name exit /b 1',
      'if not "!name:/=!"=="!name!" exit /b 1',
      'set "left=!name:.=!"',
      'if not defined left exit /b 1',
      'endlocal',
      'set "release=%release:/=\\%"',
      'set "BUN_NATIVE_DATA_DIR=%BUN_NATIVE_ROOT%\\data"',
      '"%BUN_NATIVE_ROOT%\\%release%\\application.exe" %*',
      '',
    ].join('\r\n')
  return [
    '#!/bin/sh',
    `BUN_NATIVE_ROOT='${base}'`,
    'release=$(cat "$BUN_NATIVE_ROOT/current") || exit 1',
    // Exactly versions/<name> of letters, digits, dot and hyphen, never only dots.
    'case "$release" in versions/*[!0-9A-Za-z.-]*) release= ;; versions/*[!.]*) ;; *) release= ;; esac',
    '[ -n "$release" ] || { echo "Invalid Bun Native release pointer" >&2; exit 1; }',
    'BUN_NATIVE_DATA_DIR="$BUN_NATIVE_ROOT/data"',
    'export BUN_NATIVE_DATA_DIR',
    'exec "$BUN_NATIVE_ROOT/$release/application" "$@"',
    '',
  ].join('\n')
}

function desktopEntry(name: string, launcher: string, root: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Exec="${plainPath(launcher)}" %U`,
    'Terminal=false',
    `X-Bun-Native-Root=${plainPath(root)}`,
    'X-Bun-Native-Signing=unsigned-experimental',
    '',
  ].join('\n')
}

function infoPlist(name: string, product: string, version: string, executable: string): string {
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const entries: [string, string][] = [
    ['CFBundleName', name],
    ['CFBundleIdentifier', product],
    ['CFBundleShortVersionString', version],
    ['CFBundleExecutable', executable],
    ['CFBundlePackageType', 'APPL'],
  ]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.map(([key, value]) => `  <key>${key}</key>\n  <string>${escape(value)}</string>`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

async function writeNew(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, text, { flag: 'wx', mode })
  await rename(temporary, path)
}

/** Create the launcher and menu entry for an installed product and record them for uninstall. */
export async function integrate(root: string, integration: Integration): Promise<string[]> {
  const directory = resolve(root)
  const state = await readState(directory)
  if (!state) throw new UpdateError('state', 'Nothing is installed')
  if (!namePattern.test(integration.name))
    throw new UpdateError('state', 'Application names use letters, digits, spaces, ., _ and -')
  const applications = plainPath(resolve(integration.applications))
  const windows = integration.platform === 'win32'
  const verified = integration.verifiedLauncher
  const launcher = join(
    directory,
    'bin',
    windows ? `${state.product}.${verified ? 'exe' : 'cmd'}` : state.product
  )
  if (verified) {
    await mkdir(dirname(launcher), { recursive: true })
    const temporary = `${launcher}.${randomBytes(6).toString('hex')}.tmp`
    await copyFile(resolve(verified), temporary)
    await chmod(temporary, 0o755)
    await rename(temporary, launcher)
  } else await writeNew(launcher, launcherScript(integration.platform, directory), 0o755)
  if (!windows) await chmod(launcher, 0o755)
  let entry: string
  if (integration.platform === 'linux') {
    entry = join(applications, `${state.product}.desktop`)
    await writeNew(entry, desktopEntry(integration.name, launcher, directory))
  } else if (integration.platform === 'darwin') {
    // A minimal unsigned wrapper bundle; Gatekeeper treats it as an unidentified developer app.
    entry = join(applications, `${integration.name}.app`)
    const contents = join(entry, 'Contents')
    await rm(entry, { recursive: true, force: true })
    await writeNew(
      join(contents, 'Info.plist'),
      infoPlist(integration.name, state.product, state.current.version, state.product)
    )
    // The verified launcher finds the root from its own path, so the bundle delegates to it.
    await writeNew(
      join(contents, 'MacOS', state.product),
      verified
        ? `#!/bin/sh\nexec '${plainPath(launcher)}' "$@"\n`
        : launcherScript('darwin', directory),
      0o755
    )
    await chmod(join(contents, 'MacOS', state.product), 0o755)
  } else {
    entry = join(applications, `${integration.name}.cmd`)
    await writeNew(entry, `@echo off\r\ncall "${plainPath(launcher)}" %*\r\n`)
  }
  await recordIntegration(directory, [entry])
  return [launcher, entry]
}

/**
 * Lay out a distributable experimental bundle: the update manifest, its optional
 * detached signature and the build payload. Archive it with the platform tar/zip tool.
 */
export async function createBundle(
  build: string,
  manifestPath: string,
  outdir: string
): Promise<{ directory: string; manifest: UpdateManifest; signed: boolean }> {
  const bytes = await readFile(manifestPath)
  const manifest = parseUpdateManifest(JSON.parse(bytes.toString('utf8')))
  const name = `${manifest.product}-${manifest.version}-${manifest.target.os}-${manifest.target.architecture}`
  const directory = join(resolve(outdir), name)
  await mkdir(directory) // An existing bundle directory is never adopted.
  await writeFile(join(directory, 'update.json'), bytes, { flag: 'wx' })
  let signed = false
  try {
    await copyFile(`${manifestPath}.sig`, join(directory, 'update.json.sig'))
    signed = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (signed !== (manifest.trust === 'ed25519'))
    throw new UpdateError(
      'untrusted',
      `A ${manifest.trust} manifest ${signed ? 'has' : 'lacks'} a signature`
    )
  for (const path of Object.keys(manifest.files)) {
    await mkdir(dirname(join(directory, 'payload', path)), { recursive: true })
    await copyFile(join(build, path), join(directory, 'payload', path))
    const digest = await fileDigest(join(directory, 'payload', path))
    const expected = manifest.files[path]!
    if (digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256)
      throw new UpdateError('integrity', `Build file ${path} does not match the update manifest`)
  }
  await writeFile(
    join(directory, 'README.txt'),
    [
      `${manifest.product} ${manifest.version} for ${manifest.target.os}/${manifest.target.architecture}`,
      manifest.trust === 'ed25519'
        ? 'Update manifest is Ed25519-signed; the OS code signature is NOT present (unsigned experimental package).'
        : 'UNSIGNED EXPERIMENTAL package: neither the update manifest nor the executables are signed.',
      'Install: bun scripts/release-update.ts install update.json --payload payload --root INSTALL_DIR (trust options in docs/updates.md)',
      '',
    ].join('\n'),
    { flag: 'wx' }
  )
  return { directory, manifest, signed }
}

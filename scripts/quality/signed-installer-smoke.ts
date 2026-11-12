#!/usr/bin/env bun
/**
 * Install a release from its installer image and start it (#249): open the `.dmg`,
 * `.zip` or `.tar.gz`, verify every native executable's OS signature (with
 * `--expect-signed`), run the image's own install script, install a second update as a
 * pending release with the bundled updater, start the installed verifying launcher and wait
 * until the application's own health report is committed, then stop it. On macOS it also
 * requires the installed host to run from an application bundle with an identifier, the
 * only kind of process macOS serves user notifications, and records that host's path
 * (`installedHost`) for the notification check. The evidence JSON records every step. A display is required on Linux (Xvfb in CI).
 *
 * Linux has no OS signature, so its hosted run (native-linux.yml) adds checks of the update
 * manifest trust root instead:
 *
 * - `--verify-installation`: every installed release file and the `bin/` launcher are the
 *   bundle's bytes and nothing else, the release records the bundle's Ed25519 key, a
 *   manifest altered after signing is refused by the bundled updater, a modified installed
 *   application is refused by the installed verifying launcher, and the running processes
 *   are the installed release's AOT application and host
 * - `--window-title TITLE`: after the health check, an X11 window with that title shows more
 *   than one color within 30 seconds; its capture is kept as `installed-window.png` beside
 *   the evidence JSON
 * - `--uninstall`: after stopping, the bundled updater's `uninstall --purge-data` leaves no
 *   installation root, no menu entry and none of the application's processes
 */
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { copyFile, mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileDigest } from '../native/artifact.ts'
import { enclosingBundle, findSigntool, runCommand, verifyTree } from '../native/signing.ts'

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    installer: { type: 'string' },
    'second-update': { type: 'string' },
    work: { type: 'string' },
    evidence: { type: 'string' },
    'expect-signed': { type: 'boolean' },
    'verify-installation': { type: 'boolean' },
    'window-title': { type: 'string' },
    uninstall: { type: 'boolean' },
    timeout: { type: 'string', default: '120' },
  },
})
if (!values.installer || !values['second-update'] || !values.work || !values.evidence)
  throw new Error(
    'Usage: signed-installer-smoke.ts --installer FILE --second-update update.json --work NEW_DIR --evidence FILE.json [--expect-signed] [--verify-installation] [--window-title TITLE] [--uninstall]'
  )
if ((values['verify-installation'] || values['window-title']) && process.platform !== 'linux')
  throw new Error('--verify-installation and --window-title are Linux checks')
const installer = resolve(values.installer)
const work = resolve(values.work)
const windows = process.platform === 'win32'
const exe = windows ? '.exe' : ''
const evidence: Record<string, unknown> = {
  installer,
  platform: process.platform,
  architecture: process.arch,
  steps: [] as string[],
}
const step = (text: string) => {
  ;(evidence['steps'] as string[]).push(text)
  console.log(text)
}

function run(command: string[], what: string): string {
  const result = runCommand(command)
  if (result.exitCode !== 0)
    throw new Error(`${what} failed (${result.exitCode})\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function withoutHost(): Record<string, string | undefined> {
  const { BUN_NATIVE_HOST: _host, ...environment } = process.env
  return environment
}

/** Processes whose executable is one of `paths`, or under a directory ending in `/` (Linux /proc). */
function runningFrom(paths: string[]): { pid: number; executable: string }[] {
  const found: { pid: number; executable: string }[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let executable: string
    try {
      executable = readlinkSync(`/proc/${name}/exe`)
    } catch {
      continue
    }
    if (
      paths.some((path) => (path.endsWith('/') ? executable.startsWith(path) : executable === path))
    )
      found.push({ pid: Number(name), executable })
  }
  return found
}

await mkdir(work)
let mounted: string | undefined
/** Killed if a check fails while it runs. */
let started: Bun.Subprocess | undefined
const root = join(work, 'install root')
try {
  let opened: string
  if (installer.endsWith('.dmg')) {
    mounted = join(work, 'volume')
    run(
      ['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mounted, installer],
      'Mounting'
    )
    opened = mounted
  } else {
    opened = join(work, 'extracted')
    await mkdir(opened)
    // Windows' own bsdtar reads ZIP archives; Git's GNU tar earlier on PATH would not.
    const tar = windows
      ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
    run([tar, '-xf', installer, '-C', opened], 'Extracting')
  }
  const entries = readdirSync(opened).filter((name) => !name.startsWith('.'))
  if (entries.length !== 1) throw new Error(`Expected one bundle directory, found ${entries}`)
  const bundle = join(opened, entries[0]!)
  step(`Opened ${installer} as ${bundle}`)
  const update = JSON.parse(readFileSync(join(bundle, 'update.json'), 'utf8')) as {
    product: string
    version: string
    trust: string
    files: Record<string, { bytes: number; sha256: string }>
  }
  const build = JSON.parse(readFileSync(join(bundle, 'payload', 'manifest.json'), 'utf8')) as {
    application: { file: string }
    host: { file: string }
  }
  const platform = process.platform
  const signatures = (path: string) => {
    if (platform !== 'darwin' && platform !== 'win32')
      throw new Error(`OS signatures are not checked on ${platform}`)
    return verifyTree(path, platform, runCommand, windows ? { signtool: findSigntool() } : {})
  }
  if (values['expect-signed']) {
    const verified = await signatures(bundle)
    const names = verified.map((entry) => entry.file)
    for (const required of [
      `payload/${build.application.file}`,
      `payload/${build.host.file}`,
      `bun-native-update${exe}`,
      `launcher${exe}`,
    ])
      if (!names.includes(required)) throw new Error(`${required} is not a signed executable`)
    evidence['imageSignatures'] = verified
    step(`Verified ${verified.length} signed executables in the image: ${names.join(', ')}`)
    if (windows) {
      evidence['scriptSignature'] = await signatures(join(bundle, 'install.ps1'))
      step('Verified the install script signature')
    }
    if (platform === 'darwin') {
      // Recorded, not required: only a notarized Developer ID signature passes Gatekeeper.
      const assessed = runCommand([
        'spctl',
        '--assess',
        '--type',
        'execute',
        '--verbose=2',
        join(bundle, 'payload', build.application.file),
      ])
      evidence['gatekeeper'] = {
        exitCode: assessed.exitCode,
        output: (assessed.stderr + assessed.stdout).trim(),
      }
      step(
        `Gatekeeper assessment of the application: ${(assessed.stderr + assessed.stdout).trim()}`
      )
    }
  }

  const menu = join(work, 'menu')
  if (windows)
    run(
      [
        'pwsh',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(bundle, 'install.ps1'),
        '-Root',
        root,
        '-Menu',
        menu,
      ],
      'The install script'
    )
  else run(['/bin/sh', join(bundle, 'install.sh'), root, menu], 'The install script')
  const launcher = join(root, 'bin', `${update.product}${exe}`)
  if (!existsSync(launcher)) throw new Error(`The install script created no ${launcher}`)
  step(`Installed with the image's install script into ${root}`)
  if (values['expect-signed']) {
    evidence['installedSignatures'] = [
      ...(await signatures(join(root, 'versions'))),
      ...(await signatures(launcher)),
    ]
    step('Installed executables and the verifying launcher keep valid signatures')
  }

  const state = () =>
    JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as {
      current: { version: string; directory: string; trust: { kind: string; key?: string } }
      health: unknown
    }
  const updater = join(bundle, `bun-native-update${exe}`)
  if (values['verify-installation']) {
    // The installed release holds exactly the update manifest's files, as the bundle's bytes.
    const installed = join(root, state().current.directory)
    const listed = (directory: string, prefix = ''): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? listed(join(directory, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`]
      )
    const expected = Object.keys(update.files).sort()
    const present = listed(installed).sort()
    if (JSON.stringify(present) !== JSON.stringify(expected))
      throw new Error(`The installed release holds ${present}, not the manifest's ${expected}`)
    for (const path of expected) {
      const want = update.files[path]!
      for (const file of [join(bundle, 'payload', path), join(installed, path)]) {
        const actual = await fileDigest(file)
        if (actual.bytes !== want.bytes || actual.sha256 !== want.sha256)
          throw new Error(`${file} does not match update.json`)
      }
    }
    const binLauncher = await fileDigest(launcher)
    const bundleLauncher = await fileDigest(join(bundle, `launcher${exe}`))
    if (binLauncher.sha256 !== bundleLauncher.sha256)
      throw new Error(`${launcher} is not the bundle's verifying launcher`)
    evidence['installedFiles'] = { release: state().current.directory, files: expected.length }
    step(
      `The installed release holds exactly the ${expected.length} manifest files as the bundle's bytes, and bin/ holds the bundle's verifying launcher`
    )

    const keys = JSON.parse(readFileSync(join(bundle, 'keys.json'), 'utf8')) as {
      keys: { id: string }[]
    }
    const trust = state().current.trust
    if (
      update.trust !== 'ed25519' ||
      trust.kind !== 'ed25519' ||
      !keys.keys.some((key) => key.id === trust.key)
    )
      throw new Error(
        `The release is not trusted through the bundle's key set: ${JSON.stringify(trust)}`
      )
    step(
      `The installed release is trusted through Ed25519 key ${trust.key} of the bundle's key set`
    )

    // A manifest changed after signing is refused before anything is installed.
    const altered = join(work, 'altered', 'update.json')
    await mkdir(dirname(altered))
    const second = resolve(values['second-update'])
    const text = readFileSync(second, 'utf8')
    const changed = text.replace(/"version": "([^"]+)"/, '"version": "$1-altered"')
    if (changed === text) throw new Error('The second update has no version to alter')
    await writeFile(altered, changed)
    await copyFile(`${second}.sig`, `${altered}.sig`)
    const refused = runCommand([
      updater,
      'install',
      altered,
      '--payload',
      join(bundle, 'payload'),
      '--root',
      root,
      '--key-set',
      join(bundle, 'keys.json'),
    ])
    const refusal = (refused.stderr + refused.stdout).trim()
    if (refused.exitCode === 0 || !/signature/i.test(refusal))
      throw new Error(`An altered manifest was not refused for its signature: ${refusal}`)
    if (state().current.version !== update.version)
      throw new Error('A refused manifest changed the installation')
    evidence['alteredManifest'] = { exitCode: refused.exitCode, output: refusal }
    step(`The bundled updater refused a manifest altered after signing: ${refusal}`)

    // The verifying launcher re-hashes the release on every start: one changed byte of the
    // installed application stops it before the application runs.
    const application = join(installed, build.application.file)
    const flip = async () => {
      const handle = await open(application, 'r+')
      try {
        const byte = Buffer.alloc(1)
        await handle.read(byte, 0, 1, 1024)
        byte[0] = byte[0]! ^ 0xff
        await handle.write(byte, 0, 1, 1024)
      } finally {
        await handle.close()
      }
    }
    await flip()
    const tampered = Bun.spawnSync([launcher], {
      cwd: work,
      env: withoutHost(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    })
    await flip()
    const launcherRefusal = (tampered.stderr.toString() + tampered.stdout.toString()).trim()
    if (tampered.exitCode === 0 || tampered.signalCode || !/was modified/.test(launcherRefusal))
      throw new Error(
        `The launcher did not refuse a modified application (exit ${tampered.exitCode}): ${launcherRefusal}`
      )
    const restored = await fileDigest(application)
    if (restored.sha256 !== update.files[build.application.file]!.sha256)
      throw new Error('The application was not restored')
    evidence['modifiedApplication'] = { exitCode: tampered.exitCode, output: launcherRefusal }
    step(`The installed verifying launcher refused a modified application: ${launcherRefusal}`)
  }

  // The health check needs a confirmed release to fall back to, so the second update
  // (same payload, higher sequence) becomes the pending release the launcher starts.
  const second = resolve(values['second-update'])
  run(
    [
      updater,
      'install',
      second,
      '--payload',
      join(bundle, 'payload'),
      '--root',
      root,
      '--key-set',
      join(bundle, 'keys.json'),
      '--health-limit',
      '2',
    ],
    'The pending update'
  )
  if (state().health === null) throw new Error('The second update is not pending')
  step(`Installed ${state().current.version} as a pending release`)

  const app = Bun.spawn([launcher], {
    cwd: work,
    env: withoutHost(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  started = app
  const deadline = performance.now() + Number(values.timeout) * 1000
  while (state().health !== null) {
    if (app.exitCode !== null || performance.now() > deadline) {
      app.kill('SIGKILL')
      throw new Error(
        `The application did not confirm its health (exit ${app.exitCode}): ${await new Response(app.stderr).text()}`
      )
    }
    await Bun.sleep(200)
  }
  step(`The application confirmed ${state().current.version} through the verifying launcher`)
  const releaseDirectory = join(root, state().current.directory)
  const releaseExecutables = [build.application.file, build.host.file].map((file) =>
    join(releaseDirectory, file)
  )
  if (values['verify-installation']) {
    const running = runningFrom(releaseExecutables)
    for (const executable of releaseExecutables)
      if (!running.some((entry) => entry.executable === executable))
        throw new Error(`No process runs from ${executable}`)
    evidence['running'] = running
    step(
      `The installed AOT application and host run from ${state().current.directory}: ${running
        .map((entry) => `${entry.executable} (${entry.pid})`)
        .join(', ')}`
    )
  }
  const title = values['window-title']
  if (title) {
    // Captured from the X server, so this is what the window shows, not what was requested.
    const png = join(dirname(resolve(values.evidence)), 'installed-window.png')
    const literal = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = `^${literal}$`
    const paintDeadline = performance.now() + 30_000
    let colors = 0
    let window = ''
    for (;;) {
      window = runCommand(['xdotool', 'search', '--onlyvisible', '--name', pattern])
        .stdout.trim()
        .split('\n')[0]!
      if (window && runCommand(['import', '-window', window, png]).exitCode === 0)
        colors = Number(runCommand(['identify', '-format', '%k', png]).stdout.trim())
      if (colors > 1) break
      if (app.exitCode !== null || performance.now() > paintDeadline)
        throw new Error(
          `The installed application's window '${title}' did not paint (window ${window || 'none'}, ${colors} colors)`
        )
      await Bun.sleep(200)
    }
    evidence['window'] = { title, id: window, colors, capture: png }
    step(`The installed application's window '${title}' painted ${colors} colors (${png})`)
  }
  if (platform === 'darwin') {
    const executable = join(root, state().current.directory, build.host.file)
    const bundle = enclosingBundle(executable)
    if (!bundle) throw new Error(`The installed host ${executable} is not in an application bundle`)
    const identifier = run(
      [
        'plutil',
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        join(bundle, 'Contents', 'Info.plist'),
      ],
      'Reading the host bundle identifier'
    ).trim()
    if (!identifier) throw new Error(`${bundle} has no bundle identifier`)
    const running = run(['pgrep', '-f', executable], 'Finding the running bundled host').trim()
    if (!running) throw new Error(`No host runs from ${executable}`)
    evidence['installedHost'] = { executable, bundle, identifier, running: running.split('\n') }
    step(`The installed host runs from ${bundle} as ${identifier}`)
  }
  if (windows) {
    // The launcher's children (application and host) are stopped with it.
    run(['taskkill', '/T', '/F', '/PID', String(app.pid)], 'Stopping the application')
    await app.exited
    evidence['exit'] = 'terminated with taskkill /T /F'
  } else {
    app.kill('SIGTERM')
    const code = await app.exited
    if (code !== 0) throw new Error(`The launcher exited ${code} after SIGTERM`)
    evidence['exit'] = 0
  }
  step('Stopped the application')
  if (values.uninstall) {
    if (platform === 'linux') {
      // The application and host exit with the launcher; give them 10 seconds to finish.
      const exitDeadline = performance.now() + 10_000
      while (runningFrom(releaseExecutables).length > 0) {
        if (performance.now() > exitDeadline)
          throw new Error(
            `Processes outlived the launcher: ${JSON.stringify(runningFrom(releaseExecutables))}`
          )
        await Bun.sleep(200)
      }
    }
    run([updater, 'uninstall', '--root', root, '--purge-data'], 'Uninstalling')
    if (existsSync(root)) throw new Error(`Uninstalling left ${root}`)
    const entries = existsSync(menu) ? readdirSync(menu) : []
    if (entries.length > 0) throw new Error(`Uninstalling left menu entries: ${entries}`)
    step('Uninstalled with --purge-data: no installation root, menu entry or process remains')
  }
  evidence['status'] = 'passed'
} catch (error) {
  evidence['status'] = 'failed'
  evidence['error'] = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
  console.error(evidence['error'])
} finally {
  if (started && started.exitCode === null) started.kill('SIGKILL')
  // After a failed check, an installed application and host would outlive their launcher
  // and keep this script waiting.
  if (process.platform === 'linux')
    for (const { pid } of runningFrom([`${root}/`])) process.kill(pid, 'SIGKILL')
  if (mounted) runCommand(['hdiutil', 'detach', mounted, '-force'])
  await writeFile(values.evidence, JSON.stringify(evidence, null, 2) + '\n')
}

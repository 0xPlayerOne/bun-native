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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
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
    timeout: { type: 'string', default: '120' },
  },
})
if (!values.installer || !values['second-update'] || !values.work || !values.evidence)
  throw new Error(
    'Usage: signed-installer-smoke.ts --installer FILE --second-update update.json --work NEW_DIR --evidence FILE.json [--expect-signed]'
  )
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

await mkdir(work)
let mounted: string | undefined
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

  const root = join(work, 'install root')
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

  // The health check needs a confirmed release to fall back to, so the second update
  // (same payload, higher sequence) becomes the pending release the launcher starts.
  const second = resolve(values['second-update'])
  run(
    [
      join(bundle, `bun-native-update${exe}`),
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
  const state = () =>
    JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as {
      current: { version: string; directory: string }
      health: unknown
    }
  if (state().health === null) throw new Error('The second update is not pending')
  step(`Installed ${state().current.version} as a pending release`)

  const { BUN_NATIVE_HOST: _host, ...environment } = process.env
  const app = Bun.spawn([launcher], {
    cwd: work,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
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
  evidence['status'] = 'passed'
} catch (error) {
  evidence['status'] = 'failed'
  evidence['error'] = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
  console.error(evidence['error'])
} finally {
  if (mounted) runCommand(['hdiutil', 'detach', mounted, '-force'])
  await writeFile(values.evidence, JSON.stringify(evidence, null, 2) + '\n')
}

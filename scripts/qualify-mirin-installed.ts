/** Real Mirin packaged first-run/full-updater transaction. Local fixture only. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { referenceInstallation } from '../benchmarks/adapters/references/packages.ts'
import { createWorkbenchDesktopProbe } from '../benchmarks/lib/workbench-desktop.ts'
import type { DesktopProbe } from '../benchmarks/lib/desktop-probe.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import { transferArtifact } from '../benchmarks/lib/artifact-transfer.ts'
import { directoryBytes } from '../benchmarks/lib/accounting.ts'
import { loadWorkbenchAssets } from './workbench.ts'
import { verifyInstalledTransition } from '../benchmarks/lib/installed-acceptance.ts'
const root = resolve(import.meta.dir, '..')
const python = process.env['PYTHON'] ?? 'python3'
async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}
async function transaction(workspace: string) {
  const token = randomBytes(24).toString('hex')
  const state = { token: randomBytes(24).toString('hex'), counter: 17 }
  const events: Record<string, unknown>[] = []
  const steps: Record<string, unknown>[] = []
  const commands: Record<string, unknown>[] = []
  const report: Record<string, unknown> = {
    schema: 1,
    framework: 'Mirin',
    version: '0.1.0-alpha.26',
    runClass: 'local-smoke',
    profile: 'real-upstream-full-update+local-ad-hoc-signing',
    passed: false,
    steps,
    commands,
    events,
    sourceCommit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root })
      .stdout.toString()
      .trim(),
    sourceClean:
      Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root }).stdout.toString().trim() ===
      '',
    limitations: [
      'Not Developer ID or notarization',
      'Local HTTP entity bodies, not internet throughput or protocol overhead',
      'Initial install uses the upstream full bundle; not a DMG installer',
      'Full update, not delta',
      'Launch Services reparenting is independently PID/executable/exit checked; outer tree metrics exclude that new process',
      'Retained state is fixture-owned disk state; no browser-cookie persistence claim',
    ],
  }
  const pub = new Map<string, { file?: string; body?: string }>()
  let origin = ''
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 8192,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.headers.get('host') !== new URL(origin).host)
        return new Response(null, { status: 403 })
      if (url.pathname === '/events' && request.method === 'POST') {
        if (request.headers.has('origin') || request.headers.get('x-lifecycle-token') !== token)
          return new Response(null, { status: 403 })
        const value = (await request.json()) as Record<string, unknown>
        if (
          events.length >= 64 ||
          ![
            'started',
            'update-available',
            'download-verified',
            'apply-requested',
            'closing',
            'failed',
          ].includes(String(value['name']))
        )
          return new Response(null, { status: 400 })
        events.push({ ...value, elapsedMs: performance.now() })
        return new Response(null, { status: 202 })
      }
      if (request.method !== 'GET') return new Response(null, { status: 405 })
      const entry = pub.get(url.pathname)
      if (!entry) return new Response(null, { status: 404 })
      return entry.file
        ? new Response(Bun.file(entry.file), {
            headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
          })
        : new Response(entry.body!, {
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          })
    },
  })
  origin = server.url.origin
  const environment: Record<string, string | undefined> = {
    HOME: join(workspace, 'home'),
    USERPROFILE: join(workspace, 'home'),
    PATH: dirname(process.execPath) + ':' + (process.env['PATH'] ?? ''),
    MIRIN_SIGN_IDENTITY: '-',
    MIRIN_RELEASE_BASE_URL: origin,
    MIRIN_RELEASE_CHANNEL: 'acceptance',
    MIRIN_NOTARY_APPLE_ID: undefined,
    MIRIN_NOTARY_PASSWORD: undefined,
    MIRIN_NOTARY_TEAM_ID: undefined,
    MIRIN_APP_VERSION: undefined,
    MIRIN_CDP_PORT: undefined,
    MIRIN_CORE: undefined,
    MIRIN_WORKER: undefined,
    MIRIN_CONFIG_JSON: undefined,
    MIRIN_DEV_URL: undefined,
    MIRIN_MANIFEST_JSON: undefined,
    MIRIN_UPDATE_BASE_URL: origin,
  }
  const probes: DesktopProbe[] = []
  let probe: DesktopProbe | undefined
  let app: ReturnType<typeof Bun.spawn> | undefined
  let appEnded = false
  const controlFile = join(workspace, 'control.json'),
    statePath = join(workspace, 'profile/state.json')
  const templates = join(root, 'benchmarks/fixtures/desktop-edit')
  async function command(name: string, args: string[], cwd = workspace) {
    const path = join(workspace, `commands/${commands.length}-${name}.json`)
    const observation = await observedCommand(args, {
      cwd,
      output: path,
      env: environment,
      timeoutMs: 240000,
    }).result
    commands.push({ name, report: path, observation })
    assertCleanCommand(observation)
    return observation
  }
  try {
    const install = await referenceInstallation(
      'mirin',
      join(root, '.bunly/references/mirin'),
      await hashFile(join(root, 'benchmarks/adapters/references/locks/mirin.bun.lock'))
    )
    for (const path of ['src', 'home', 'profile', 'commands', 'published', 'installed'])
      await mkdir(join(workspace, path), { mode: 0o700 })
    await symlink(install.nodeModules, join(workspace, 'node_modules'), 'dir')
    await copyFile(join(templates, 'host.ts.txt'), join(workspace, 'src/host.ts'))
    const source = (await readFile(join(templates, 'mirin-update.ts.txt'), 'utf8')).replace(
      '__CONTROL_FILE__',
      JSON.stringify(controlFile)
    )
    await writeFile(join(workspace, 'src/main.ts'), source)
    await writeFile(
      join(workspace, 'index.html'),
      '<!doctype html><title>Private installed acceptance</title>'
    )
    await writeFile(join(workspace, 'vite.config.ts'), 'export default {build:{outDir:"dist"}}')
    const appName = 'BunlyInstalled' + token.slice(0, 8)
    await writeFile(
      join(workspace, 'mirin.config.ts'),
      `export default ${JSON.stringify({
        name: appName,
        id: 'dev.bunly.acceptance.' + token.slice(0, 12),
        main: 'src/main.ts',
        windows: {},
        singleInstance: false,
        dmg: false,
        nsis: false,
        inno: false,
        linux: false,
        release: { baseUrl: origin, channel: 'acceptance' },
      })}`
    )
    const manifests: Record<string, unknown>[] = []
    const bundles: string[] = []
    for (const revision of ['0.0.1', '0.0.2']) {
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({
          name: 'bunly-private-installed-acceptance',
          version: revision,
          private: true,
          type: 'module',
        })
      )
      await writeFile(join(workspace, 'src/revision.ts'), `export const revision = '${revision}'`)
      const started = performance.now()
      await command('release-' + revision, [process.execPath, install.entry, 'release'])
      const manifest = JSON.parse(
        await readFile(join(workspace, 'build/release/acceptance-darwin-arm64-update.json'), 'utf8')
      )
      const bundle = join(workspace, 'published', revision + '.tar.zst')
      await copyFile(join(workspace, 'build/release', manifest.bundle.url), bundle)
      assert.equal(await hashFile(bundle), manifest.bundle.sha256)
      assert.equal(Bun.file(bundle).size, manifest.bundle.size)
      manifests.push(manifest)
      bundles.push(bundle)
      steps.push({
        name: 'upstream-release-' + revision,
        passed: true,
        elapsedMs: performance.now() - started,
        manifest,
        signing: 'upstream-ad-hoc-inseparable-from-build',
        installer: 'updater-full-bundle-not-DMG',
      })
    }
    const m1 = manifests[0] as { bundle: { sha256: string; size: number }; tarHash: string }
    const m2 = manifests[1] as {
      bundle: { sha256: string; size: number; url: string }
      tarHash: string
    }
    pub.set('/first.tar.zst', { file: bundles[0]! })
    pub.set('/acceptance-darwin-arm64-update.json', { body: JSON.stringify(m2) })
    pub.set('/' + m2.bundle.url, { file: bundles[1]! })
    const firstStarted = performance.now()
    const transfer = await transferArtifact(
      {
        category: 'first-run-download',
        url: origin + '/first.tar.zst',
        allowedOrigins: [origin],
        path: 'download/first.tar.zst',
        expectedBytes: m1.bundle.size,
        sha256: m1.bundle.sha256,
        allowLoopbackHttp: true,
      },
      { workspace, timeoutMs: 120000 }
    )
    report['firstRunTransfer'] = transfer
    assert.equal(transfer.status, 'passed')
    const codec = join(install.nodeModules, '@mirinjs/darwin-arm64/mirin-codec')
    await command('decompress-initial', [
      codec,
      'decompress',
      join(workspace, 'download/first.tar.zst'),
      join(workspace, 'first.tar'),
    ])
    assert.equal(await hashFile(join(workspace, 'first.tar')), m1.tarHash)
    // These are exact locally generated, independently hash-verified upstream tar bytes.
    await command('extract-initial', [
      '/usr/bin/tar',
      '-xf',
      join(workspace, 'first.tar'),
      '-C',
      join(workspace, 'installed'),
    ])
    const application = join(workspace, 'installed', appName + '.app')
    const executable = await realpath(join(application, 'Contents/MacOS', appName))
    await command('verify-initial-signature', [
      '/usr/bin/codesign',
      '--verify',
      '--deep',
      '--strict',
      application,
    ])
    report['initialInstalledBytes'] = await directoryBytes(
      'installed',
      application,
      'Verified extracted initial upstream full bundle'
    )
    const assets = await loadWorkbenchAssets()
    const html = await readFile(join(templates, 'index.html'), 'utf8'),
      javascript = await readFile(join(templates, 'client.js'), 'utf8')
    async function nextProbe(revision: string) {
      const next = await createWorkbenchDesktopProbe(
        {
          revision,
          state: state.token,
          counter: state.counter,
          framework: 'Mirin',
          version: '0.1.0-alpha.26',
          html,
          javascript,
          timeoutMs: 60000,
        },
        assets
      )
      const c = next.configuration
      await writeFile(
        controlFile,
        JSON.stringify({
          home: environment['HOME'],
          updateOrigin: origin,
          token,
          state,
          apply: false,
          environment: {
            BUNLY_EDIT_ORIGIN: c.origin,
            BUNLY_EDIT_LAUNCH: c.launch,
            BUNLY_EDIT_HOST_TOKEN: c.hostToken,
            BUNLY_EDIT_RENDERER_TOKEN: c.rendererToken,
            BUNLY_EDIT_STATE: statePath,
            BUNLY_EDIT_FRAME_ORIGIN: c.workbenchOrigin,
          },
        }),
        { mode: 0o600 }
      )
      probes.push(next)
      return next
    }
    probe = await nextProbe('0.0.1')
    app = Bun.spawn([executable], {
      cwd: dirname(executable),
      env: { ...process.env, ...environment },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    void app.exited.then(() => {
      appEnded = true
    })
    const first = await Promise.race([
      probe.completion,
      app.exited.then((code) => {
        throw new Error('Initial app exited before ready: ' + code)
      }),
    ])
    steps.push({
      name: 'installed-first-run',
      passed: true,
      elapsedMs: performance.now() - firstStarted,
      observation: first,
    })
    const oldProbe = probe
    probe = await nextProbe('0.0.2')
    const control = JSON.parse(await readFile(controlFile, 'utf8'))
    control.apply = true
    await writeFile(controlFile, JSON.stringify(control), { mode: 0o600 })
    const updateStarted = performance.now()
    oldProbe.requestQuit()
    const second = await probe.completion
    verifyInstalledTransition(first, second, events, m2.bundle.size)
    assert.notEqual(first.host.pid, second.host.pid)
    assert.notEqual(first.host.instance, second.host.instance)
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).token, state.token)
    const download = events.find((event) => event['name'] === 'download-verified')
    assert.ok(download)
    assert.equal(download['received'], m2.bundle.size)
    assert.equal(download['total'], m2.bundle.size)
    await command('verify-updated-signature', [
      '/usr/bin/codesign',
      '--verify',
      '--deep',
      '--strict',
      application,
    ])
    const version = JSON.parse(
      await readFile(join(application, 'Contents/Resources/version.json'), 'utf8')
    )
    assert.equal(version.version, '0.0.2')
    const registered = observedCommand(
      [
        python,
        join(root, 'scripts/registered_app.py'),
        String(second.host.pid),
        executable,
        '--timeout',
        '35',
      ],
      {
        cwd: workspace,
        output: join(workspace, 'commands/registered-relaunch.json'),
        timeoutMs: 40000,
      }
    )
    await Bun.sleep(150)
    steps.push({
      name: 'upstream-update-and-relaunch',
      passed: true,
      elapsedMs: performance.now() - updateStarted,
      observation: second,
      receivedUpdateBodyBytes: download['received'],
      tarSha256: m2.tarHash,
      retainedFixtureState: true,
    })
    probe.requestQuit()
    const registeredReport = await registered.result
    assertCleanCommand(registeredReport)
    report['registeredRelaunch'] = registeredReport
    await oldProbe.close()
    assert.equal(await app.exited, 0)
    report['finalInstalledBytes'] = await directoryBytes(
      'installed',
      application,
      'Installed second version after upstream swap and signature verification'
    )
    report['cacheBytes'] = await directoryBytes(
      'cache',
      join(workspace, 'home'),
      'Private build and updater cache; not network traffic'
    )
    report['passed'] = true
  } catch (error) {
    report['failure'] = error instanceof Error ? error.message : 'Installed transaction failed'
    process.exitCode = 1
  } finally {
    for (const owned of probes) {
      owned.requestQuit()
      await owned.close()
    }
    if (app && !appEnded) {
      app.kill()
      await app.exited
    }
    await server.stop(true)
    await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    })
  }
  console.log(JSON.stringify({ passed: report['passed'], workspace, failure: report['failure'] }))
}
if (import.meta.main) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This installed Mirin acceptance targets macOS arm64')
  if (process.argv[2] === '--worker') await transaction(resolve(process.argv[3]!))
  else {
    const parent = join(root, '.bunly/acceptance/m2-completion')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const workspace = await mkdtemp(join(parent, 'mirin-installed-'))
    const report = await observedCommand(
      [process.execPath, import.meta.path, '--worker', workspace],
      { cwd: root, output: join(workspace, 'supervisor.json'), timeoutMs: 600000 }
    ).result
    console.log(
      JSON.stringify({
        workspace,
        exitCode: report.exitCode,
        orphans: report.observedOrphans,
        cleanupSurvivors: report.cleanupSurvivors,
      })
    )
    assertCleanCommand(report)
  }
}

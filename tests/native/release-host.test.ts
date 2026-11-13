import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { compileApplication } from '../../scripts/native/compile.ts'
import { buildProject } from '../../scripts/native/build.ts'
import { prebuiltHost } from '../../scripts/native/host.ts'
import { createProject, readProject } from '../../scripts/native/project.ts'
import { readLauncherReport } from './launcher-report.ts'
import { PROTOCOL_VERSION } from '@bun-native/protocol'
import toolchain from '../../toolchain.json'

// Release-host qualification for #247 that needs the actual prebuilt
// `bun-native-host` (BUN_NATIVE_HOST). Without it every case is reported as
// skipped with its reason in the test name, never as passed.
const host = process.env['BUN_NATIVE_HOST']
const hostSkip = !host
  ? 'BUN_NATIVE_HOST is unset'
  : !isAbsolute(host) || !existsSync(host) || !statSync(host).isFile()
    ? 'BUN_NATIVE_HOST does not name an absolute prebuilt host file'
    : undefined
const root = resolve(import.meta.dir, '../..')
const directory = mkdtempSync(join(tmpdir(), 'bun-native-release-host-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function skipped(name: string, reason: string | undefined): string {
  return reason ? `${name} (skipped: ${reason})` : name
}

const linuxSkip = hostSkip ?? (process.platform !== 'linux' ? 'Linux only' : undefined)

function environment(overrides: Record<string, string>, remove: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !remove.includes(name)) result[name] = value
  return { ...result, XDG_RUNTIME_DIR: mkdtempSync(join(directory, 'runtime-')), ...overrides }
}

function fixture(name: string, env: Record<string, string>) {
  const run = Bun.spawnSync([process.execPath, join(root, 'tests/native', name)], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  if (run.exitCode !== 0)
    throw new Error(`${name} failed (${run.exitCode}): ${run.stderr.toString()}`)
  return JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!) as Record<string, unknown>
}

// A private Xvfb display for one case, with Mesa's software Vulkan driver when
// it is the only one installed (as on the hosted Linux runner).
async function virtualDisplay(): Promise<{
  environment: Record<string, string>
  stop(): Promise<void>
}> {
  const server = Bun.spawn(
    ['Xvfb', '-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const stop = async () => {
    server.kill('SIGKILL')
    await server.exited
  }
  try {
    const reader = server.stdout.getReader()
    let number = ''
    while (!number.includes('\n')) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Xvfb exited before reporting its display')
      number += new TextDecoder().decode(value)
    }
    reader.releaseLock()
    const environment: Record<string, string> = {
      DISPLAY: `:${number.trim()}`,
      GPUI_X11_SCALE_FACTOR: '1',
    }
    const icds = existsSync('/usr/share/vulkan/icd.d')
      ? readdirSync('/usr/share/vulkan/icd.d').filter((name) => /^lvp_icd.*\.json$/.test(name))
      : []
    if (icds.length === 1)
      environment['VK_DRIVER_FILES'] = join('/usr/share/vulkan/icd.d', icds[0]!)
    return { environment, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

type BoundaryReport = {
  status: string
  protocol: number
  offline: boolean
  display: boolean
  skipped: { name: string; reason: string }[]
  results: { name: string; exit: number }[]
}

function expectBoundary(report: BoundaryReport, display: boolean, offline: boolean): void {
  expect(report.status).toBe('passed')
  expect(report.protocol).toBe(PROTOCOL_VERSION)
  expect(report.offline).toBe(offline)
  expect(report.display).toBe(display)
  const names = report.results.map((result) => result.name)
  for (const name of [
    'version-mismatch-is-recoverable',
    'eof-inside-a-frame-is-terminal',
    'unknown-command-type-is-terminal',
    'invalid-utf8-frame-is-terminal',
    'terminated-frame-over-the-byte-limit-is-terminal',
  ])
    expect(names).toContain(name)
  if (display) expect(names).toContain('opens-and-closes-a-real-window')
  else
    expect(report.skipped).toEqual([
      { name: 'opens-and-closes-a-real-window', reason: 'no display' },
    ])
  expect(report.results.every((result) => result.exit === 0)).toBe(true)
}

// With neither DISPLAY nor WAYLAND_DISPLAY, GPUI selects its headless Linux
// platform, so the release host serves the protocol without any display.
test.if(!linuxSkip)(
  skipped('release host rejects raw boundary frames with no display at all', linuxSkip),
  () => {
    const report = fixture(
      'boundary.ts',
      environment({ BUN_NATIVE_HOST: host! }, [
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'WAYLAND_SOCKET',
        'BUN_NATIVE_REQUIRE_OFFLINE',
      ])
    )
    expectBoundary(report as BoundaryReport, false, false)
  },
  90_000
)

// An unreachable X display makes GPUI itself panic during startup: a real
// native panic, reported through the Bun launch as a typed redacted diagnostic.
test.if(!linuxSkip)(
  skipped('release host GPUI startup panic is a typed, redacted launch diagnostic', linuxSkip),
  () => {
    const display = `bun-native-unreachable-${crypto.randomUUID()}`
    const report = fixture(
      'startup-panic.ts',
      environment({ BUN_NATIVE_HOST: host!, DISPLAY: display }, [
        'WAYLAND_DISPLAY',
        'WAYLAND_SOCKET',
      ])
    )
    expect(report).toMatchObject({
      reason: 'panic',
      exitCode: 101,
      signal: null,
      phase: 'starting',
      panicReport: true,
      redacted: true,
    })
    expect(String(report['panicLocation'])).toMatch(/gpui_linux\/src\/linux\/platform\.rs:\d+:\d+$/)
    expect(report['elapsedMs'] as number).toBeLessThan(5_000)
  },
  90_000
)

// A real Rust panic after the session is established: the release host reads
// the test-only BUN_NATIVE_TEST_FAULT=panic-in-batch at startup, opens a real
// window, then panics inside the GPUI update of its first batch. The pending
// batch, the window and the application reject with one typed `panic`
// diagnostic in the `running` phase, located at the injected panic, with every
// ownership counter back at zero. RUST_BACKTRACE=1 makes the backtrace clip
// the captured stderr, so the panic report must survive that clipping.
const sessionPanicSkip = linuxSkip ?? (Bun.which('Xvfb') === null ? 'Xvfb is required' : undefined)
test.if(!sessionPanicSkip)(
  skipped(
    'release host GPUI panic after the session is established is a typed running-phase diagnostic',
    sessionPanicSkip
  ),
  async () => {
    const display = await virtualDisplay()
    try {
      const report = fixture(
        'session-panic.ts',
        environment(
          {
            ...display.environment,
            BUN_NATIVE_HOST: host!,
            BUN_NATIVE_TEST_FAULT: 'panic-in-batch',
            RUST_BACKTRACE: '1',
          },
          ['WAYLAND_DISPLAY', 'WAYLAND_SOCKET']
        )
      )
      expect(report).toMatchObject({
        reason: 'panic',
        exitCode: 101,
        signal: null,
        phase: 'running',
        pendingRequests: 1,
        panicMessage: true,
        ownership: {
          windows: 0,
          nodes: 0,
          callbacks: 0,
          queuedTransactions: 0,
          queuedCallbacks: 0,
          activeCallbacks: 0,
          serviceRequests: 0,
        },
      })
      // Redaction may replace a path segment equal to an inherited value (on
      // GitHub Actions, GITHUB_JOB is "native"); over-redaction is allowed.
      expect(String(report['panicLocation'])).toMatch(
        /(?:native|\[redacted\])\/gpui-host\/src\/session\.rs:\d+:\d+$/
      )
      expect(report['elapsedMs'] as number).toBeLessThan(5_000)
    } finally {
      await display.stop()
    }
  },
  90_000
)

// Offline launch of an inspected AOT application: the raw-frame boundary
// fixture compiled with the pinned AOT compiler (compiled-program record and
// JIT removal checked), run under Xvfb inside an empty network namespace.
const offline =
  process.platform === 'linux' &&
  Bun.which('unshare') !== null &&
  Bun.spawnSync(['unshare', '-rn', 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
// xvfb-run runs its command with stderr merged into stdout, and the
// dbus-run-session daemon and the portal services it activates keep writing to
// that stream while the session tears down ("Authorization required, but no
// authorization protocol specified", "X connection to :99 broken"), after the
// application printed its report. Hosted run 42189398221 parsed one of those
// lines as the report (#530), and about 15% of local runs showed the same
// trailing lines. The application therefore writes its report to a file of its
// own; everything else stays on the launcher's streams for failure messages.
const SESSION_REPORT_TO_FILE = 'exec dbus-run-session -- sh -c \'exec "$0" >"$1"\' "$0" "$1"'
const aotSkip =
  hostSkip ??
  (!offline
    ? 'unprivileged user and network namespaces (unshare -rn) are unavailable'
    : Bun.which('xvfb-run') === null || Bun.which('dbus-run-session') === null
      ? 'xvfb-run and dbus-run-session are required'
      : Bun.revision !== toolchain.bun.revision
        ? 'the pinned Bun AOT compiler is required'
        : undefined)
test.if(!aotSkip)(
  skipped(
    'inspected AOT boundary application launches and qualifies the release host offline',
    aotSkip
  ),
  () => {
    const outdir = mkdtempSync(join(directory, 'aot-'))
    const application = join(outdir, 'boundary')
    const { inspection, runtimeFeatures } = compileApplication(
      join(root, 'tests/native/boundary.ts'),
      application,
      root
    )
    expect(inspection.hasCompiledProgram).toBe(true)
    expect(runtimeFeatures.jit).not.toBe('present')

    const reportFile = join(outdir, 'boundary-report.json')
    const icds = existsSync('/usr/share/vulkan/icd.d')
      ? readdirSync('/usr/share/vulkan/icd.d').filter((name) => /^lvp_icd.*\.json$/.test(name))
      : []
    const run = Bun.spawnSync(
      [
        'unshare',
        '--map-root-user',
        '--net',
        'xvfb-run',
        '--auto-servernum',
        '--server-args=-screen 0 1280x800x24 -nolisten tcp',
        'sh',
        '-c',
        SESSION_REPORT_TO_FILE,
        application,
        reportFile,
      ],
      {
        cwd: outdir,
        env: {
          ...environment({}, ['WAYLAND_DISPLAY', 'WAYLAND_SOCKET']),
          BUN_NATIVE_HOST: host!,
          BUN_NATIVE_REQUIRE_OFFLINE: '1',
          GPUI_X11_SCALE_FACTOR: '1',
          LIBGL_ALWAYS_SOFTWARE: '1',
          ...(icds.length === 1
            ? { VK_DRIVER_FILES: join('/usr/share/vulkan/icd.d', icds[0]!) }
            : {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
      }
    )
    if (run.exitCode !== 0)
      throw new Error(
        `Offline AOT boundary failed (${run.exitCode}): ${run.stdout.toString()}${run.stderr.toString()}`
      )
    expectBoundary(
      readLauncherReport<BoundaryReport>(
        { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() },
        reportFile,
        'Offline AOT boundary'
      ),
      true,
      true
    )
  },
  300_000
)

// A real `native build` application, installed as a pending update and started
// through the compiled verifying launcher, confirms its own health (#249): the
// generated template calls reportHealthy() after its first native render, the
// launcher commits the confirmation, and SIGTERM still reaches the application
// through the launcher for a clean exit.
const updateSkip =
  hostSkip ??
  (process.platform !== 'linux'
    ? 'Linux only'
    : Bun.which('Xvfb') === null
      ? 'Xvfb is required'
      : Bun.revision !== toolchain.bun.revision
        ? 'the pinned Bun AOT compiler is required'
        : undefined)
test.if(!updateSkip)(
  skipped(
    'a native build application confirms its pending update through the verifying launcher',
    updateSkip
  ),
  async () => {
    const work = mkdtempSync(join(directory, 'update-'))
    // Projects are created inside the checkout; its ignored cache holds this one.
    mkdirSync(join(root, '.bun-native'), { recursive: true })
    const project = mkdtempSync(join(root, '.bun-native', 'update-app-'))
    rmSync(project, { recursive: true })
    const build = join(work, 'build')
    try {
      await createProject(root, project, 'solid', 'typescript')
      await buildProject(
        await readProject(root, project),
        await prebuiltHost(host!),
        build,
        'release'
      )
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
    const update = (...args: string[]) => {
      const result = Bun.spawnSync(
        [process.execPath, join(root, 'scripts/release-update.ts'), ...args],
        { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 }
      )
      if (result.exitCode !== 0)
        throw new Error(`release-update ${args[0]} failed: ${result.stderr.toString()}`)
      return result.stdout.toString()
    }
    const installRoot = join(work, 'install')
    const product = 'dev.bun-native.template'
    // The health check needs a confirmed release to fall back to; both releases
    // carry the same build, so the one the launcher starts is this application.
    const install = (sequence: number, health: string[]) => {
      const manifest = join(work, `update-${sequence}.json`)
      update(
        'manifest',
        build,
        '--product',
        product,
        '--version',
        `1.0.${sequence}`,
        '--sequence',
        String(sequence),
        '--unsigned-experimental',
        '--out',
        manifest
      )
      return update(
        'install',
        manifest,
        '--root',
        installRoot,
        '--payload',
        build,
        '--unsigned-experimental',
        ...health
      )
    }
    install(1, [])
    expect(install(2, ['--health-limit', '2'])).toContain(
      'WARNING: installed an UNSIGNED EXPERIMENTAL update'
    )
    const state = () =>
      JSON.parse(readFileSync(join(installRoot, 'state.json'), 'utf8')) as { health: unknown }
    expect(state().health).toEqual({ status: 'pending', attempts: 0, limit: 2 })
    const launcher = join(work, 'launcher')
    update('launcher', '--out', launcher)
    update(
      'integrate',
      '--root',
      installRoot,
      '--name',
      'Template',
      '--applications',
      join(work, 'menu'),
      '--verified-launcher',
      launcher
    )

    const display = await virtualDisplay()
    try {
      const env = environment(display.environment, [
        'BUN_NATIVE_HOST',
        'WAYLAND_DISPLAY',
        'WAYLAND_SOCKET',
      ])
      const app = Bun.spawn([join(installRoot, 'bin', product)], {
        cwd: work,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const deadline = performance.now() + 60_000
      while (state().health !== null) {
        if (app.exitCode !== null || performance.now() > deadline) {
          app.kill('SIGKILL')
          throw new Error(
            `The application did not confirm its update (exit ${app.exitCode}): ${await new Response(app.stderr).text()}`
          )
        }
        await Bun.sleep(100)
      }
      app.kill('SIGTERM')
      expect(await app.exited).toBe(0)
      expect(readdirSync(join(installRoot, 'health'))).toEqual([])
    } finally {
      await display.stop()
    }
  },
  300_000
)

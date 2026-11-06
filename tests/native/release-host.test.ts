import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { compileApplication } from '../../experiments/aot-gpui/compile.ts'
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

// Offline launch of an inspected AOT application: the raw-frame boundary
// fixture compiled with the pinned AOT compiler (compiled-program record and
// JIT removal checked), run under Xvfb inside an empty network namespace.
const offline =
  process.platform === 'linux' &&
  Bun.which('unshare') !== null &&
  Bun.spawnSync(['unshare', '-rn', 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
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
        'dbus-run-session',
        '--',
        application,
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
    const stdout = run.stdout.toString()
    if (run.exitCode !== 0)
      throw new Error(`Offline AOT boundary failed (${run.exitCode}): ${run.stderr.toString()}`)
    let report: BoundaryReport
    try {
      report = JSON.parse(stdout.trim().split('\n').at(-1)!) as BoundaryReport
    } catch (error) {
      // Preserve the original failing parser while retaining bounded evidence
      // of stdout contamination and the independent child stderr stream.
      console.error(
        JSON.stringify({
          diagnostic: 'offline-aot-boundary-unparseable-stdout',
          exitCode: run.exitCode,
          stdoutTail: stdout.slice(-2_048),
          stderrTail: run.stderr.toString().slice(-2_048),
        })
      )
      throw error
    }
    expectBoundary(report, true, true)
  },
  300_000
)

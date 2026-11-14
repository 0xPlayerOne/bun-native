/** Hosted-only qualification of the Electrobun input fixture, not a paired benchmark. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { decodePng } from '../../tests/native/png.ts'
import { compareVisiblePixels } from './visible-pixels.ts'
import { verifyVisibleText } from './visible-text.ts'

const TITLE = 'Bun Native matched renderer workload'
const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    output: { type: 'string' },
    helper: { type: 'string' },
    ocr: { type: 'string' },
  },
  strict: true,
})
assert(
  process.platform === 'darwin' && process.env['GITHUB_ACTIONS'] === 'true',
  'Hosted macOS only'
)
const runnerTemp = process.env['RUNNER_TEMP']
assert(runnerTemp && isAbsolute(runnerTemp), 'RUNNER_TEMP is required')
const temp = realpathSync(runnerTemp)
function ownedPath(value: string | undefined, exists: boolean): string {
  assert(value && isAbsolute(value), 'An absolute path is required')
  const path = exists
    ? realpathSync(value)
    : join(realpathSync(dirname(value)), value.split('/').at(-1)!)
  const part = relative(temp, path)
  assert(part && !part.startsWith('..') && !isAbsolute(part), 'Path must be inside RUNNER_TEMP')
  return path
}
const app = ownedPath(values.app, true)
const output = ownedPath(values.output, false)
const helper = ownedPath(values.helper, true)
const ocr = ownedPath(values.ocr, true)
assert(!existsSync(output), 'Output already exists')
const launcher = ownedPath(join(app, 'Contents/MacOS/launcher'), true)
const host = ownedPath(join(app, 'Contents/MacOS/bun'), true)
mkdirSync(output)
const reportPath = join(output, 'application.json')
const controlPath = join(output, 'control.json')
const nonce = randomUUID()
const started = performance.now()
const child = Bun.spawn([launcher], {
  detached: true,
  stdin: 'ignore',
  stdout: Bun.file(join(output, 'application.stdout.log')),
  stderr: Bun.file(join(output, 'application.stderr.log')),
  env: {
    ...process.env,
    EB_OUTPUT: reportPath,
    EB_INPUT_CONTROL: controlPath,
    EB_INPUT_NONCE: nonce,
  },
})
let groupOwned = false
let result: Record<string, unknown> = { status: 'failed', nonce }
function command(args: string[], timeout = 10_000) {
  const item = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', timeout })
  if (item.exitCode !== 0)
    throw new Error(
      `${args[0]} failed (${item.exitCode}): ${item.stderr.toString().slice(0, 2000)}`
    )
  return item.stdout.toString()
}
function groupMembers(): number[] {
  const rows = command(['ps', '-axo', 'pid=,pgid='])
  return rows.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    return match && Number(match[2]) === child.pid ? [Number(match[1])] : []
  })
}
type WindowState = {
  status: 'ready'
  application: { pid: number; parent: number; image: string; created: string }
  host: { pid: number; parent: number; image: string; created: string }
  window: { id: number; frame: [number, number, number, number] }
  windowServerTargetVerified?: boolean
  visibleRegionVerified?: boolean
  visibleRegion?: [number, number, number, number]
  injection?: { method: string; postedEvents: number; delivery: string }
}
type PendingState = { status: 'not-ready'; reason?: string }
async function helperCall(request: Record<string, unknown>): Promise<WindowState | PendingState> {
  const process = Bun.spawnSync([helper, JSON.stringify(request)], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  const raw = process.stdout.toString()
  let value: WindowState | PendingState
  try {
    value = JSON.parse(raw) as WindowState | PendingState
  } catch {
    throw new Error(
      `Owned-window helper returned invalid JSON: ${process.stderr.toString().slice(0, 2000)}`
    )
  }
  if (process.exitCode !== 0 || (value['status'] !== 'ready' && value['status'] !== 'not-ready'))
    throw new Error(`Owned-window helper failed (${process.exitCode}): ${raw.slice(0, 2000)}`)
  return value
}
async function snapshot(
  name: string,
  request: Record<string, unknown>,
  expected: WindowState,
  viewport: [number, number]
) {
  const path = join(output, `${name}.png`)
  const guard = {
    ...request,
    action: 'visible-region',
    expected,
    viewport,
    x: 12,
    y: 10,
    width: 240,
    height: 36,
  }
  const guardStart = performance.now()
  const beforeGuard = await helperCall(guard)
  assert.equal(beforeGuard.status, 'ready')
  assert.equal(beforeGuard.visibleRegionVerified, true)
  const frame = expected.window.frame
  assert(frame.every(Number.isSafeInteger), 'Display capture requires integral frame coordinates')
  const side = (frame[2] - viewport[0]) / 2
  const top = frame[3] - viewport[1] - side
  assert.deepEqual(beforeGuard.visibleRegion, [frame[0] + side + 12, frame[1] + top + 10, 240, 36])
  const before = performance.now()
  command(['screencapture', '-x', `-R${frame.join(',')}`, path])
  const captured = performance.now()
  const afterGuard = await helperCall(guard)
  assert.equal(afterGuard.status, 'ready')
  assert.equal(afterGuard.visibleRegionVerified, true)
  assert.deepEqual(afterGuard.visibleRegion, beforeGuard.visibleRegion)
  const png = decodePng(readFileSync(path))
  return {
    path,
    png,
    captureMs: captured - before,
    guardAndDecodeMs: performance.now() - guardStart - (captured - before),
    guard: { before: beforeGuard, after: afterGuard },
  }
}
function recognize(path: string, name: string, region: readonly number[]) {
  const raw = command([ocr, path, ...region.map(String)])
  writeFileSync(join(output, `${name}-ocr.json`), raw)
  return JSON.parse(raw) as unknown
}
async function main() {
  const group = Number(command(['ps', '-o', 'pgid=', '-p', String(child.pid)]).trim())
  assert.equal(group, child.pid, 'Launcher did not start in an isolated process group')
  groupOwned = true
  result['stage'] = 'awaiting-control'
  const deadline = performance.now() + 30_000
  while (!existsSync(controlPath)) {
    if (child.exitCode !== null)
      throw new Error(`Application exited before readiness: ${child.exitCode}`)
    if (performance.now() > deadline) throw new Error('Input fixture did not become ready')
    await Bun.sleep(50)
  }
  const controlStat = statSync(controlPath)
  assert(controlStat.isFile() && controlStat.size > 0 && controlStat.size <= 4096)
  const control = JSON.parse(readFileSync(controlPath, 'utf8')) as {
    nonce: string
    port: number
    viewport: [number, number]
  }
  assert.equal(control.nonce, nonce)
  assert(Number.isSafeInteger(control.port) && control.port > 0 && control.port <= 65535)
  assert(Array.isArray(control.viewport) && control.viewport.length === 2)
  assert(control.viewport.every((n) => Number.isSafeInteger(n) && n >= 128 && n <= 8192))
  const request = { app_pid: child.pid, host, title: TITLE }
  let state: WindowState | PendingState
  for (;;) {
    state = await helperCall({ ...request, action: 'observe' })
    if (state['status'] === 'ready') break
    if (performance.now() > deadline) throw new Error('No owned reference window appeared')
    await Bun.sleep(50)
  }
  assert.equal(state.status, 'ready')
  assert.equal(state['application']['parent'], process.pid, 'Launcher is not our child')
  const activated = await helperCall({ ...request, action: 'activate', expected: state })
  assert.equal(activated['status'], 'ready')
  result['stage'] = 'initial-capture'
  result['identity'] = { application: state.application, host: state.host, window: state.window }
  const frame = state['window']['frame'] as [number, number, number, number]
  assert(Array.isArray(frame) && frame.length === 4 && frame.every(Number.isFinite))
  const windowId = state['window']['id'] as number
  assert(Number.isSafeInteger(windowId) && windowId > 0)
  const first = await snapshot('initial', request, state, control.viewport)
  const scale = first.png.width / frame[2]
  assert(scale >= 1 && scale <= 4 && Math.abs(first.png.height - frame[3] * scale) <= 1)
  const side = (frame[2] - control.viewport[0]) / 2
  const top = frame[3] - control.viewport[1] - side
  assert(side >= 0 && top >= 0, 'Viewport does not fit observed frame')
  const region = [
    Math.floor((side + 12) * scale),
    Math.floor((top + 10) * scale),
    Math.floor(240 * scale),
    Math.floor(36 * scale),
  ] as const
  const regionNormalized = [
    region[0] / first.png.width,
    1 - (region[1] + region[3]) / first.png.height,
    region[2] / first.png.width,
    region[3] / first.png.height,
  ] as const
  result['region'] = region
  result['stage'] = 'initial-ocr'
  const initialText = verifyVisibleText(
    recognize(first.path, 'initial', region),
    'Initial',
    'Clicked',
    regionNormalized
  )
  const second = await snapshot('initial-control', request, state, control.viewport)
  const negative = compareVisiblePixels(first.png, second.png, region)
  assert(negative.changedPixels <= 2, 'Initial label region is not stable')
  result['negative'] = negative
  result['stage'] = 'click'
  const clickStart = performance.now()
  const injection = await helperCall({
    ...request,
    action: 'click',
    expected: state,
    viewport: control.viewport,
    x: 100,
    y: 75,
  })
  assert.equal(injection.status, 'ready')
  assert.equal(injection.windowServerTargetVerified, true)
  assert.equal(injection.injection?.postedEvents, 3)
  let changed: Awaited<ReturnType<typeof snapshot>> | undefined
  let difference: ReturnType<typeof compareVisiblePixels> | undefined
  let polls = 0
  while (performance.now() - clickStart < 10_000 && polls < 40) {
    polls++
    const shot = await snapshot(
      `post-${String(polls).padStart(2, '0')}`,
      request,
      state,
      control.viewport
    )
    const candidate = compareVisiblePixels(second.png, shot.png, region)
    if (candidate.changedPixels >= 8) {
      changed = shot
      difference = candidate
      break
    }
    await Bun.sleep(50)
  }
  assert(changed && difference, 'No visible label change was detected')
  const observedMs = performance.now() - clickStart
  result['stage'] = 'clicked-ocr'
  const clickedText = verifyVisibleText(
    recognize(changed.path, 'clicked', region),
    'Clicked',
    'Initial',
    regionNormalized
  )
  const after = await helperCall({ ...request, action: 'observe' })
  assert.equal(after.status, 'ready')
  assert.deepEqual(after['application'], state['application'])
  assert.deepEqual(after['host'], state['host'])
  assert.deepEqual(after['window'], state['window'])
  const response = await fetch(`http://127.0.0.1:${control.port}/input/finish`, {
    method: 'POST',
    headers: { 'x-benchmark-nonce': nonce },
  })
  assert(response.ok, `Reference rejected finish: ${response.status}`)
  const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)])
  assert.equal(exit, 0, 'Reference did not exit cleanly after finish')
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
  assert.equal(report['clicks'], 1)
  assert.equal(report['label'], 'Clicked')
  assert.equal(report['nonce'], nonce)
  result = {
    status: 'passed',
    stage: 'complete',
    nonce,
    identity: state,
    injection,
    frame,
    viewport: control.viewport,
    region,
    initialText,
    clickedText,
    negative,
    difference,
    polls,
    commandToDisplayCaptureObservedMs: observedMs,
    captureMs: { initial: first.captureMs, control: second.captureMs, final: changed.captureMs },
    guardAndDecodeMs: {
      initial: first.guardAndDecodeMs,
      control: second.guardAndDecodeMs,
      final: changed.guardAndDecodeMs,
    },
    displayGuards: { initial: first.guard, control: second.guard, final: changed.guard },
    scope:
      'One owned Electrobun display-region capture and guarded OS click; not paired or a physical presentation timestamp.',
  }
}
try {
  await main()
} catch (error) {
  result['error'] = error instanceof Error ? error.message : String(error)
} finally {
  if (groupOwned) {
    try {
      const remaining = groupMembers()
      result['remainingBeforeCleanup'] = remaining
      if (remaining.length) {
        process.kill(-child.pid, 'SIGTERM')
        await Promise.race([child.exited, Bun.sleep(2000)])
        result['remainingAfterCleanup'] = groupMembers()
        result['status'] = 'failed'
      }
    } catch (error) {
      // If the owned group cannot be inspected, only signal the direct child.
      if (child.exitCode === null) child.kill('SIGTERM')
      result['cleanupError'] = error instanceof Error ? error.message : String(error)
      result['status'] = 'failed'
    }
  } else if (child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(2000)])
  }
  result['wallMs'] = performance.now() - started
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
}
if (result['status'] !== 'passed')
  throw new Error(String(result['error'] ?? 'Forced process cleanup'))

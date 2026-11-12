/**
 * Real OS input into a workspace's terminal pane (#248, #250).
 *
 * The actual Solid or React workspace runs with its real shell on an owned
 * 80x24 pseudo-terminal, as the interactive example does. Everything the
 * fixture checks arrives through independent channels:
 *
 * - Input: XTEST (xdotool) on Linux X11, or CoreGraphics key and pointer
 *   events through the bounded SDK helper on macOS (tests/native/macos-window-input.ts),
 *   clicks the terminal's command input at the bounds the host painted it at,
 *   types a command and presses Return.
 * - Round trip: the command runs in `/bin/sh` and its output, which differs
 *   from the typed text, returns through the PTY to the terminal session.
 * - Paint: the host's own paint evidence (`BUN_NATIVE_EVIDENCE_LOG`) shows the
 *   output line in the tree it painted, at bounds from the same paint, and a
 *   capture of the displayed window (ImageMagick `import` on X11,
 *   `screencapture -l` of the owned window on macOS) has text-coloured pixels
 *   inside them.
 *
 * Interrupt (Ctrl-C through the PTY) and OS close (openbox Alt+F4 on X11, the
 * standard close button pressed through Accessibility on macOS) are then
 * driven the same way.
 */
import type { NativeWindow } from '@bun-native/core'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { TerminalSession } from '../../examples/shared/terminal.ts'
import { MacWindow } from './macos-window-input.ts'

const mac = process.platform === 'darwin'

export interface TerminalFixtureEnvironment {
  output: string
  host: string
  mode: 'development' | 'aot'
  log: string
  nonce: string
}

export function terminalFixtureEnvironment(): TerminalFixtureEnvironment {
  const output = process.env['BUN_NATIVE_TERMINAL_EVIDENCE']
  const host = process.env['BUN_NATIVE_HOST']
  const mode = process.env['BUN_NATIVE_TERMINAL_MODE']
  const log = process.env['BUN_NATIVE_EVIDENCE_LOG']
  const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
  if (
    !output ||
    !isAbsolute(output) ||
    !statSync(output).isDirectory() ||
    !host ||
    !isAbsolute(host) ||
    (mode !== 'development' && mode !== 'aot') ||
    !log ||
    !isAbsolute(log) ||
    !nonce ||
    (mac
      ? !process.env['BUN_NATIVE_PLATFORM_HELPER'] ||
        !isAbsolute(process.env['BUN_NATIVE_PLATFORM_HELPER'])
      : !process.env['DISPLAY'] ||
        process.env['WAYLAND_DISPLAY'] ||
        process.env['GPUI_X11_SCALE_FACTOR'] !== '1')
  )
    throw new Error(
      mac
        ? 'macOS needs an evidence directory, host, mode, host evidence log and nonce and the OS input helper'
        : 'An isolated X11 display at scale 1, evidence directory, host, mode and host evidence log and nonce are required'
    )
  return { output, host, mode, log, nonce }
}

const PLACEHOLDER = 'Type a command and press Enter'
// The typed command never contains its own output, so a matching line can
// only come from the shell having run it.
const COMMAND = "printf 'pty-%s\\n' $((6*7))"
const OUTPUT = 'pty-42'
const BLOCKING = 'sleep 30'

type Element = {
  kind: string
  text?: string
  placeholder?: string
  disabled?: boolean
  value?: string
  style?: { color?: number; background?: number }
}
type RenderedNode = { node_id: number; element: Element; children: number[] }
type Bounds = [number, number, number, number]
type Layout = {
  status: string
  viewport: [number, number]
  scale_factor: number
  focused_node_id?: number | null
  nodes?: { node_id: number; bounds: Bounds; ancestor_clip: Bounds }[]
}
type Frame = { revision: number; nodes: RenderedNode[]; layout: Layout }

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

async function waitFor<T>(
  check: () => T | undefined | false,
  description: string,
  observed: () => unknown,
  timeout = 10_000
): Promise<T> {
  const until = performance.now() + timeout
  for (;;) {
    const value = check()
    if (value !== undefined && value !== false) return value
    if (performance.now() > until)
      throw new Error(
        'Timed out waiting for ' + description + '; observed ' + JSON.stringify(observed())
      )
    await Bun.sleep(20)
  }
}

/** The newest painted tree and the newest painted geometry for the window. */
function latestFrame(log: string, nonce: string): Frame | undefined {
  let rendered: { tree_revision: number; nodes?: RenderedNode[] } | undefined
  let layout: Layout | undefined
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line) continue
    const record = JSON.parse(line) as {
      nonce?: string
      type?: string
      stage?: string
      tree_revision?: number
      nodes?: RenderedNode[]
      layout?: Layout
    }
    if (record.nonce !== nonce || record.stage !== 'native-paint') continue
    if (record.type === 'rendered') rendered = record as typeof rendered
    if (record.type === 'layout') layout = record.layout
  }
  if (!rendered?.nodes || layout?.status !== 'complete') return undefined
  return { revision: rendered.tree_revision, nodes: rendered.nodes, layout }
}

function bounds(frame: Frame, node: number): Bounds | undefined {
  const row = frame.layout.nodes?.find((entry) => entry.node_id === node)
  if (!row) return undefined
  const [x, y, width, height] = row.bounds
  const [cx, cy, cw, ch] = row.ancestor_clip
  const left = Math.max(x, cx)
  const top = Math.max(y, cy)
  const right = Math.min(x + width, cx + cw)
  const bottom = Math.min(y + height, cy + ch)
  return right > left && bottom > top ? [left, top, right - left, bottom - top] : undefined
}

function parentOf(frame: Frame, node: number) {
  return frame.nodes.find((entry) => entry.children.includes(node))
}

/**
 * Drives the mounted workspace's terminal pane with real OS input and closes
 * the window through the window manager. Returns once the window has closed.
 */
export async function driveTerminal(options: {
  environment: TerminalFixtureEnvironment
  window: NativeWindow
  session: TerminalSession
  title: string
}): Promise<Record<string, unknown>> {
  const { environment, window, session, title } = options
  const started = performance.now()
  const outcomes: Record<string, unknown> = {}
  const record = (name: string, value: unknown) => {
    outcomes[name] = value
    console.log(JSON.stringify({ outcome: name, atMs: Math.round(performance.now() - started) }))
  }
  const values: string[] = []
  window.on(window.root, 'input', (event) => void values.push(event.value), { capture: true })
  const frame = () => latestFrame(environment.log, environment.nonce)

  // The OS input for each step: XTEST on X11, the bounded CoreGraphics helper
  // on macOS (which re-identifies the owned window before every post).
  let xid = ''
  let macWindow: MacWindow | undefined
  if (mac) {
    macWindow = await MacWindow.open(title, environment.host, () => {
      const viewport = frame()?.layout.viewport
      if (!viewport) throw new Error('No painted viewport for the owned window yet')
      return viewport
    })
  } else {
    const ids = (await run(['xdotool', 'search', '--sync', '--name', '^' + title + '$'])).split(
      '\n'
    )
    assert.equal(ids.length, 1, 'exactly one owned window')
    xid = ids[0]!
    await run(['xdotool', 'windowactivate', '--sync', xid])
  }
  const click = async (x: number, y: number) => {
    if (macWindow) return macWindow.click([Math.round(x), Math.round(y)])
    await run([
      'xdotool',
      'mousemove',
      '--window',
      xid,
      String(Math.round(x)),
      String(Math.round(y)),
      'click',
      '1',
    ])
  }
  const type = async (text: string) => {
    if (macWindow) return macWindow.typeText(text, 20)
    await run(['xdotool', 'type', '--delay', '20', text])
  }
  const pressReturn = async () => {
    if (macWindow) return macWindow.press('Return')
    await run(['xdotool', 'key', '--clearmodifiers', 'Return'])
  }

  // The shell starts on the PTY and prints its prompt through it.
  await waitFor(
    () => session.current.status === 'running' && session.current.partial.endsWith('$ '),
    'the shell prompt',
    () => session.current
  )
  const commandInput = (current: Frame) =>
    current.nodes.find(
      (node) =>
        node.element.kind === 'input' &&
        node.element.placeholder === PLACEHOLDER &&
        node.element.disabled !== true
    )
  const ready = await waitFor(
    () => {
      const current = frame()
      const input = current && commandInput(current)
      return input && current && bounds(current, input.node_id) ? current : undefined
    },
    'an enabled, painted terminal command input',
    () => frame()?.layout.status
  )
  const input = commandInput(ready)!
  // X11 input and capture are in device pixels, so Linux runs at scale 1;
  // macOS input and the capture's point mapping are in logical points.
  if (!mac) assert.equal(ready.layout.scale_factor, 1)
  const [x, y, width, height] = bounds(ready, input.node_id)!
  await click(x + width / 2, y + height / 2)
  await waitFor(
    () => frame()?.layout.focused_node_id === input.node_id,
    'the clicked terminal input to take focus',
    () => frame()?.layout.focused_node_id
  )
  record('focused', { node: input.node_id, bounds: [x, y, width, height] })

  // Real key events type the command into the native input.
  await type(COMMAND)
  await waitFor(
    () => values.at(-1) === COMMAND,
    'the typed command in the native input',
    () => values.slice(-3)
  )
  assert.equal(
    session.current.lines.some((line) => line.text.includes(OUTPUT)),
    false,
    'no output before Return'
  )
  await pressReturn()
  // The terminal echoes the command line and then prints the shell's output.
  const lines = await waitFor(
    () => {
      const current = session.current.lines.map((line) => line.text)
      return current.includes(OUTPUT) ? current : undefined
    },
    'the command output through the PTY',
    () => session.current
  )
  const echoed = lines.findIndex((line) => line.endsWith(COMMAND))
  assert(echoed >= 0, 'the PTY echoes the command line')
  assert(lines.indexOf(OUTPUT) > echoed, 'the output follows the echoed command')
  // Enter submitted the native input's text and cleared it.
  await waitFor(
    () => frame()?.nodes.find((node) => node.node_id === input.node_id)?.element.value === '',
    'the submitted input to clear',
    () => frame()?.nodes.find((node) => node.node_id === input.node_id)?.element
  )
  record('roundTrip', { command: COMMAND, lines })

  // Paint: the host painted a text node with the output, and the displayed
  // window has text-coloured pixels inside its painted bounds.
  const painted = await waitFor(
    () => {
      const current = frame()
      const node = current?.nodes.find(
        (entry) => entry.element.kind === 'text' && entry.element.text === OUTPUT
      )
      const box = current && node && bounds(current, node.node_id)
      return current && node && box ? { current, node, box } : undefined
    },
    'the output line in a painted frame',
    () => frame()?.revision
  )
  const ink = painted.node.element.style?.color
  const paper = parentOf(painted.current, painted.node.node_id)?.element.style?.background
  assert(ink !== undefined && paper !== undefined, 'the output line has a colour and a background')
  await Bun.sleep(100)
  const capture = join(environment.output, 'terminal-output.png')
  const [bx, by, bw, bh] = painted.box.map(Math.round) as Bounds
  const channels = (color: number) => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
  const distance = (a: number[], b: number[]) =>
    a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0)
  let inked = 0
  let total = 0
  let expected = bw * bh
  const count = (color: number) => {
    const rgb = channels(color)
    total += 1
    if (distance(rgb, channels(ink)) < distance(rgb, channels(paper))) inked += 1
  }
  let scale = 1
  if (macWindow) {
    // Every physical capture pixel inside the logical painted bounds.
    const shot = await macWindow.capture(capture)
    scale = shot.scale
    const [columns, rows] = [Math.round(bw * scale), Math.round(bh * scale)]
    expected = columns * rows
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1)
        count(shot.pixel([bx + (column + 0.5) / scale, by + (row + 0.5) / scale]))
  } else {
    await run(['import', '-window', xid, capture])
    const pixels = await run([
      'convert',
      capture,
      '-crop',
      `${bw}x${bh}+${bx}+${by}`,
      '-depth',
      '8',
      'txt:-',
    ])
    for (const match of pixels.matchAll(/#([0-9A-F]{6})/gi)) count(Number.parseInt(match[1]!, 16))
  }
  record('paint', {
    revision: painted.current.revision,
    bounds: painted.box,
    ink: ink.toString(16),
    paper: paper.toString(16),
    ...(macWindow ? { scale } : {}),
    inked,
    total,
  })
  assert.equal(total, expected, 'the capture covers the painted bounds')
  assert(inked >= 20, `the output line is visibly painted (${inked} text-coloured pixels)`)

  // Ctrl-C from the pane's Interrupt button stops a foreground job through
  // the PTY; the same shell prints a new prompt and keeps running.
  values.length = 0
  await click(x + width / 2, y + height / 2)
  await type(BLOCKING)
  await waitFor(
    () => values.at(-1) === BLOCKING,
    'the blocking command',
    () => values.slice(-3)
  )
  await pressReturn()
  const blockingLine = await waitFor(
    () => session.current.lines.findLast((line) => line.text.endsWith(BLOCKING))?.id,
    'the blocking command to start',
    () => session.current
  )
  // The job holds the terminal: no new prompt arrives while it runs.
  await Bun.sleep(500)
  assert.equal(session.current.partial, '', 'no prompt while the job runs')
  const interrupt = await waitFor(
    () => {
      const current = frame()
      const button = current?.nodes.find(
        (node) =>
          node.element.kind === 'button' &&
          node.element.text === 'Interrupt' &&
          node.element.disabled !== true
      )
      const box = current && button && bounds(current, button.node_id)
      return box || undefined
    },
    'the painted Interrupt button',
    () => frame()?.revision
  )
  const interruptedAt = performance.now()
  await click(interrupt[0] + interrupt[2] / 2, interrupt[1] + interrupt[3] / 2)
  await waitFor(
    () =>
      session.current.status === 'running' &&
      session.current.partial.endsWith('$ ') &&
      session.current.lines.some((line) => line.id > blockingLine),
    'a new prompt after the interrupt',
    () => session.current,
    5_000
  )
  record('interrupt', { promptAfterMs: Math.round(performance.now() - interruptedAt) })

  // OS close through the window manager: openbox Alt+F4 on X11; on macOS the
  // owned window's standard close button, pressed through Accessibility.
  if (macWindow) {
    await macWindow.activate()
    await macWindow.close()
  } else {
    await run(['xdotool', 'windowactivate', '--sync', xid])
    await run(['xdotool', 'key', '--clearmodifiers', 'alt+F4'])
  }
  await window.closed
  record('closed', { status: session.current.status })
  if (macWindow) outcomes['osInput'] = macWindow.log
  return outcomes
}

export function writeTerminalResult(
  environment: TerminalFixtureEnvironment,
  scenario: string,
  outcomes: Record<string, unknown>,
  extra: Record<string, unknown>
) {
  const result = {
    status: 'passed',
    scenario,
    platform: process.platform,
    mode: environment.mode,
    outcomes,
    ...extra,
  }
  writeFileSync(join(environment.output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'passed', scenario, mode: environment.mode }))
}

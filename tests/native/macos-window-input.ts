/**
 * Real macOS OS input to, and pixels from, one owned GPUI window, for the
 * native fixtures that drive an X11 window through xdotool on Linux.
 *
 * Input goes through the bounded SDK helper (scripts/quality/native-platform-macos.m,
 * BUN_NATIVE_PLATFORM_HELPER): before every post it re-identifies this
 * application, its host child and the exact Quartz window, brings the host to
 * the foreground, refuses held modifiers or buttons, and checks that AppKit's
 * mouse-down target at each pointer position is the owned window. Pixels come
 * from `screencapture -l` of that window, cropped to the GPUI viewport from the
 * observed frame, as native-workspace-macos.py does.
 *
 * Callers speak the xdotool vocabulary the Linux fixtures use: key names such
 * as `Tab`, `shift+Tab`, `ctrl+a`, `Escape`, `Return`, `space` and letters;
 * pointer buttons 1 (left), 4 (wheel up) and 5 (wheel down) at a viewport point;
 * `close` for the window manager's close.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { decodePng } from './png.ts'

export type Point = readonly [number, number]
type State = Record<string, unknown> & {
  window: { id: number; frame: [number, number, number, number] }
}

/** xdotool modifier names to the helper's. */
const MODIFIERS: Record<string, string> = {
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'option',
  super: 'command',
}
const NAMED = new Set([
  'Return',
  'Escape',
  'BackSpace',
  'Delete',
  'Tab',
  'space',
  'Left',
  'Right',
  'Up',
  'Down',
  'Home',
  'End',
])
// gpui_linux SCROLL_LINES at the pinned revision: one X11 wheel notch is three lines.
const NOTCH_LINES = 3

/** One xdotool key name as a helper chord. */
export function chord(name: string): { key: string; modifiers: string[] } {
  const parts = name.split('+')
  const key = parts.pop()!
  const modifiers = parts.map((part) => {
    const mapped = MODIFIERS[part.toLowerCase()]
    if (!mapped) throw new Error('Unknown modifier in ' + name)
    return mapped
  })
  if (NAMED.has(key) || /^[a-z]$/.test(key)) return { key, modifiers }
  if (/^[A-Z]$/.test(key) && !modifiers.includes('shift'))
    return { key: key.toLowerCase(), modifiers: [...modifiers, 'shift'] }
  throw new Error('No bounded macOS key for ' + name)
}

/** The host is this process's direct child; its executable is the host path. */
export async function hostPid(host: string): Promise<number> {
  const list = Bun.spawnSync(['pgrep', '-P', String(process.pid)], { stdout: 'pipe' })
  const children = list.stdout.toString().split('\n').filter(Boolean)
  for (const child of children) {
    const command = Bun.spawnSync(['ps', '-o', 'comm=', '-p', child], { stdout: 'pipe' })
    const name = command.stdout.toString().trim()
    if (name === host || name.endsWith('/bun-native-host')) return Number(child)
  }
  throw new Error('The native host process was not found among ' + children.join(', '))
}

export interface Capture {
  /** Physical pixels per logical point, from the capture and the Quartz frame. */
  scale: number
  /** The viewport's physical size in the capture. */
  size: [number, number]
  /** The displayed colour at a logical viewport point, as 0xRRGGBB. */
  pixel(point: Point): number
}

export class MacWindow {
  readonly #helper: string
  readonly #host: string
  readonly #title: string
  readonly #viewport: () => Point
  #state: State
  /** Every helper request and its injection summary, for the evidence record. */
  readonly log: unknown[] = []

  private constructor(
    helper: string,
    host: string,
    title: string,
    viewport: () => Point,
    state: State
  ) {
    this.#helper = helper
    this.#host = host
    this.#title = title
    this.#viewport = viewport
    this.#state = state
  }

  get windowId() {
    return this.#state.window.id
  }

  get frame() {
    return this.#state.window.frame
  }

  static async #call(
    helper: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    onStderrLine?: (line: string) => void
  ): Promise<State & { status: string; error?: string }> {
    const child = Bun.spawn([helper, JSON.stringify(request)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    })
    const stderr = (async () => {
      let text = ''
      const decoder = new TextDecoder()
      for await (const chunk of child.stderr) {
        text += decoder.decode(chunk, { stream: true })
        let newline: number
        while ((newline = text.indexOf('\n')) >= 0) {
          onStderrLine?.(text.slice(0, newline))
          text = text.slice(newline + 1)
        }
      }
      return text
    })()
    const [stdout, rest, code] = await Promise.all([
      new Response(child.stdout).text(),
      stderr,
      child.exited,
    ])
    let value: State & { status: string; error?: string }
    try {
      value = JSON.parse(stdout)
    } catch {
      throw new Error(`The macOS input helper returned no JSON (exit ${code}): ${rest.trim()}`)
    }
    if (value.status === 'unsupported')
      throw new Error(`macOS OS input is unavailable: ${value.error}`)
    if (code !== 0 || (value.status !== 'ready' && value.status !== 'not-ready'))
      throw new Error(`The macOS input helper failed: ${value.error ?? code}`)
    return value
  }

  /**
   * The one onscreen window with this title owned by this application's host
   * child, activated. `viewport` reports the current GPUI viewport size in
   * logical points, from the host's own layout evidence.
   */
  static async open(title: string, host: string, viewport: () => Point): Promise<MacWindow> {
    const helper = process.env['BUN_NATIVE_PLATFORM_HELPER']
    if (!helper || !isAbsolute(helper))
      throw new Error('macOS OS input needs an absolute BUN_NATIVE_PLATFORM_HELPER')
    const request = { action: 'observe', app_pid: process.pid, host: realpathSync(host), title }
    const until = performance.now() + 10_000
    for (;;) {
      const state = await MacWindow.#call(helper, request, 5_000)
      if (state.status === 'ready') {
        const window = new MacWindow(helper, request.host, title, viewport, state)
        await window.activate()
        return window
      }
      if (performance.now() > until)
        throw new Error(`No onscreen macOS window titled ${title} owned by this application`)
      await Bun.sleep(50)
    }
  }

  async #input(
    action: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 5_000,
    onStderrLine?: (line: string) => void
  ) {
    const request = {
      action,
      app_pid: process.pid,
      host: this.#host,
      title: this.#title,
      expected: this.#state,
      ...extra,
    }
    const result = await MacWindow.#call(this.#helper, request, timeoutMs, onStderrLine)
    this.log.push({ action, ...extra, injection: result['injection'] })
    return result
  }

  async activate() {
    await this.#input('activate')
  }

  /** xdotool `key` names, posted in order as real key presses. */
  async press(...names: string[]) {
    await this.#input('keys', { keys: names.map(chord), delayMs: 20 }, 5_000 + names.length * 100)
  }

  /**
   * Printable ASCII as key presses: letters by their own virtual key code
   * (with Shift for capitals), anything else as a Unicode key event.
   */
  async type(text: string) {
    // Consecutive letters go in one helper call, as one typed run (a menu's
    // type-ahead must see them inside its search interval).
    let run: string[] = []
    const flush = async () => {
      if (run.length) await this.press(...run)
      run = []
    }
    for (const character of text) {
      if (/^[A-Za-z]$/.test(character)) run.push(character)
      else if (character === ' ') run.push('space')
      else {
        await flush()
        await this.#input('type', { text: character })
      }
    }
    await flush()
  }

  /**
   * Printable ASCII in one helper call, every character a Unicode key event
   * `delayMs` apart, as native_harness/native_platform_input.py `type_printable` types into
   * the workspace references' inputs. For text entry, where the inserted
   * characters matter and not the keys' names.
   */
  async typeText(text: string, delayMs = 20) {
    await this.#input('type', { text, delayMs }, 5_000 + text.length * (delayMs + 20))
  }

  #viewportRequest() {
    const [width, height] = this.#viewport()
    return [width, height]
  }

  /** Button 1 clicks; 4 and 5 are one wheel notch up or down, as on X11. */
  async click([x, y]: Point, button: '1' | '4' | '5' = '1') {
    const viewport = this.#viewportRequest()
    if (button === '1') await this.#input('click', { x, y, viewport })
    else
      await this.#input('scroll', {
        x,
        y,
        viewport,
        lines: button === '4' ? NOTCH_LINES : -NOTCH_LINES,
        repeat: 1,
      })
  }

  /**
   * One left-button drag through `points`. With `holdMs`, the button stays
   * down that long after the last move; `held` runs once it is held there.
   */
  async drag(points: Point[], holdMs?: number, held?: () => void) {
    await this.#input(
      'drag',
      {
        points: points.map(([x, y]) => [x, y]),
        viewport: this.#viewportRequest(),
        ...(holdMs === undefined ? {} : { holdMs }),
      },
      5_000 + (holdMs ?? 0),
      (line) => {
        if (line === 'held') held?.()
      }
    )
  }

  /** An Accessibility resize of the owned window to this viewport size. */
  async resize(width: number, height: number) {
    const result = await this.#input('resize', { width, height, viewport: this.#viewportRequest() })
    const { injection: _, ...state } = result
    this.#state = state as State
  }

  /**
   * The OS close of the owned window: its standard close button pressed
   * through Accessibility, the macOS form of the window manager's Alt+F4.
   * The caller observes the close through its own native evidence.
   */
  async close() {
    await this.#input('close')
  }

  /** Capture the owned window and read displayed viewport pixels. */
  async capture(file: string): Promise<Capture> {
    return this.#capture(file, (id) => ['-o', `-l${id}`])
  }

  /**
   * The same viewport pixels from the display itself: a `screencapture -R`
   * of the window's observed Quartz frame, which reads the composited screen
   * rather than the window's own surface. Diagnostic only; the helper has
   * just raised the owned window, and its frame is a global top-left rect.
   */
  async captureDisplay(file: string): Promise<Capture> {
    return this.#capture(file, (_, frame) => [`-R${frame.map(Math.round).join(',')}`])
  }

  /**
   * After a window capture kept showing a frame other than the expected one,
   * read `points` from the window surface and then from the display, saving
   * both captures beside `file`. Equal values mean the display itself shows
   * that frame (GPUI's presentation); differing values mean the window
   * capture lags what is on screen. The values are reported, never asserted.
   */
  async staleCapture(file: string, points: Point[]) {
    // A failed diagnostic read is reported in place of its values, so it never
    // replaces the caller's own failure.
    const read = async (capture: Promise<Capture>) => {
      try {
        const shot = await capture
        return points.map((point) => shot.pixel(point).toString(16))
      } catch (error) {
        return points.map(() => 'unavailable: ' + (error as Error).message)
      }
    }
    const window = await read(this.capture(file.replace(/\.png$/, '-stale-window.png')))
    const display = await read(this.captureDisplay(file.replace(/\.png$/, '-stale-display.png')))
    return { window, display }
  }

  async #capture(
    file: string,
    source: (id: number, frame: [number, number, number, number]) => string[]
  ): Promise<Capture> {
    const state = (await this.#input('observe')) as State
    if (state.window.id !== this.#state.window.id)
      throw new Error('The owned window changed before capture')
    const frame = state.window.frame
    const work = mkdtempSync(join(tmpdir(), 'bun-native-capture-'))
    try {
      const raw = join(work, 'window.png')
      const capture = Bun.spawnSync(
        ['screencapture', '-x', ...source(state.window.id, frame), raw],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10_000,
        }
      )
      if (capture.exitCode !== 0)
        throw new Error(`screencapture failed (${capture.exitCode}): ${capture.stderr}`)
      const bytes = readFileSync(raw)
      await Bun.write(file, bytes)
      const png = decodePng(bytes)
      const scale = png.width / frame[2]
      if (!(scale >= 1) || Math.abs(png.height - frame[3] * scale) > 1)
        throw new Error(
          `The capture ${png.width}x${png.height} is not the Quartz frame ${frame[2]}x${frame[3]}`
        )
      const [width, height] = this.#viewport()
      const side = (frame[2] - width) / 2
      const top = frame[3] - height - side
      if (side < 0 || top < 0) throw new Error('The GPUI viewport does not fit the Quartz frame')
      return {
        scale,
        size: [Math.round(width * scale), Math.round(height * scale)],
        pixel: ([x, y]) => {
          if (x < 0 || y < 0 || x >= width || y >= height)
            throw new Error(`Viewport point ${x},${y} is outside ${width}x${height}`)
          return png.rgb(Math.floor((side + x) * scale), Math.floor((top + y) * scale))
        },
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

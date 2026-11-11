import { realpathSync } from 'node:fs'
import { platform } from 'node:os'

/**
 * Real OS input for the workspace long sessions (#248, #250): XTest on a
 * private Linux X11 display, or the bounded CoreGraphics helper on macOS. These
 * drivers only run inside the native soak fixtures on a real display; the
 * session bookkeeping they report into lives in workspace-session.ts.
 */
function run(command: string[], timeoutMs = 10_000): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
  if (result.exitCode !== 0)
    throw new Error(
      `${command.slice(0, 2).join(' ')} failed (${result.exitCode}): ${result.stderr}`
    )
  return result.stdout.toString().trim()
}

export interface OsInput {
  activate(): void
  type(text: string): void
  key(name: 'Return'): void
  /** Wheel notches at a window-relative point: button 5 scrolls down, 4 up. */
  wheel(x: number, y: number, button: 4 | 5, notches: number): void
  readonly counts: { typedCharacters: number; keys: number; wheelNotches: number }
}

/** The platform's real OS input to the owned host window. */
export async function openOsInput(
  title: string,
  hostPid: number,
  host: string,
  viewport: readonly [number, number]
): Promise<OsInput> {
  return platform() === 'darwin'
    ? await MacInput.open(title, host, viewport)
    : await X11Input.open(title, hostPid)
}

/**
 * Real X11 keyboard and wheel input to the owned host window through XTest
 * (xdotool), refusing any window another process owns.
 */
class X11Input implements OsInput {
  readonly window: string
  typedCharacters = 0
  keys = 0
  wheelNotches = 0

  private constructor(window: string) {
    this.window = window
  }

  static async open(title: string, hostPid: number): Promise<X11Input> {
    const until = performance.now() + 10_000
    while (performance.now() < until) {
      const found = Bun.spawnSync(['xdotool', 'search', '--onlyvisible', '--name', `^${title}$`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      for (const candidate of found.stdout.toString().split(/\s+/).filter(Boolean)) {
        const owner = Bun.spawnSync(['xdotool', 'getwindowpid', candidate], { stdout: 'pipe' })
        if (owner.stdout.toString().trim() === String(hostPid)) {
          const input = new X11Input(candidate)
          input.activate()
          return input
        }
      }
      await Bun.sleep(50)
    }
    throw new Error(`No visible window titled ${title} owned by host ${hostPid}`)
  }

  activate() {
    run(['xdotool', 'windowactivate', '--sync', this.window])
    this.requireFocus()
  }

  requireFocus() {
    if (run(['xdotool', 'getwindowfocus']) !== this.window)
      throw new Error('The owned workspace window lost X11 focus before input')
  }

  type(text: string) {
    this.requireFocus()
    run(['xdotool', 'type', '--clearmodifiers', '--delay', '5', text])
    this.typedCharacters += text.length
  }

  key(name: 'Return') {
    this.requireFocus()
    run(['xdotool', 'key', '--clearmodifiers', name])
    this.keys++
  }

  /** Wheel notches at a window-relative point: button 5 scrolls down, 4 up. */
  wheel(x: number, y: number, button: 4 | 5, notches: number) {
    this.requireFocus()
    run([
      'xdotool',
      'mousemove',
      '--window',
      this.window,
      String(x),
      String(y),
      'click',
      '--repeat',
      String(notches),
      '--delay',
      '10',
      String(button),
    ])
    this.wheelNotches += notches
  }

  get counts() {
    return {
      typedCharacters: this.typedCharacters,
      keys: this.keys,
      wheelNotches: this.wheelNotches,
    }
  }
}

/**
 * CoreGraphics key and wheel events through the bounded macOS helper, which
 * re-observes the owned application, host and window, brings the host to the
 * foreground and refuses held modifiers before every post. The X11 wheel
 * buttons map to three-line wheel events, as in native-workspace-macos.py.
 */
class MacInput implements OsInput {
  readonly #helper: string
  readonly #host: string
  readonly #title: string
  readonly #viewport: readonly [number, number]
  #state: Record<string, unknown>
  typedCharacters = 0
  keys = 0
  wheelNotches = 0

  private constructor(
    helper: string,
    host: string,
    title: string,
    viewport: readonly [number, number],
    state: Record<string, unknown>
  ) {
    this.#helper = helper
    this.#host = host
    this.#title = title
    this.#viewport = viewport
    this.#state = state
  }

  static #call(helper: string, request: Record<string, unknown>, timeoutMs: number) {
    const result = Bun.spawnSync([helper, JSON.stringify(request)], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    })
    let value: { status?: string; error?: string } & Record<string, unknown>
    try {
      value = JSON.parse(result.stdout.toString())
    } catch {
      throw new Error(`The macOS input helper returned no JSON (exit ${result.exitCode})`)
    }
    if (value.status === 'unsupported')
      throw new Error(`macOS OS input is unavailable: ${value.error}`)
    if (result.exitCode !== 0 || (value.status !== 'ready' && value.status !== 'not-ready'))
      throw new Error(`The macOS input helper failed: ${value.error ?? result.exitCode}`)
    return value
  }

  static async open(title: string, host: string, viewport: readonly [number, number]) {
    const helper = process.env['BUN_NATIVE_PLATFORM_HELPER']!
    const request = { action: 'observe', app_pid: process.pid, host: realpathSync(host), title }
    const until = performance.now() + 10_000
    while (performance.now() < until) {
      const state = MacInput.#call(helper, request, 5_000)
      if (state.status === 'ready') {
        const input = new MacInput(helper, request.host, title, viewport, state)
        input.activate()
        return input
      }
      await Bun.sleep(50)
    }
    throw new Error(`No onscreen macOS window titled ${title} owned by this application`)
  }

  #input(action: string, extra: Record<string, unknown>, timeoutMs = 5_000) {
    MacInput.#call(
      this.#helper,
      {
        action,
        app_pid: process.pid,
        host: this.#host,
        title: this.#title,
        expected: this.#state,
        ...extra,
      },
      timeoutMs
    )
  }

  activate() {
    this.#input('activate', {})
  }

  type(text: string) {
    this.#input('type', { text, delayMs: 5 }, 5_000 + text.length * 20)
    this.typedCharacters += text.length
  }

  key(name: 'Return') {
    this.#input('key', { key: name, modifiers: [] })
    this.keys++
  }

  wheel(x: number, y: number, button: 4 | 5, notches: number) {
    this.#input(
      'scroll',
      {
        x,
        y,
        viewport: [...this.#viewport],
        lines: button === 4 ? 3 : -3,
        repeat: notches,
        delayMs: 10,
      },
      5_000 + notches * 20
    )
    this.wheelNotches += notches
  }

  get counts() {
    return {
      typedCharacters: this.typedCharacters,
      keys: this.keys,
      wheelNotches: this.wheelNotches,
    }
  }
}

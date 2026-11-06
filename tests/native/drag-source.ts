/**
 * Drives an independent OS drag source process, one command per line, so the
 * native drag and drop tests exercise the platform's own drag machinery and
 * GPUI's real drop target code, never a synthesized GPUI event:
 *
 * - X11: `xdnd-source`, an x11rb XDND v5 client that grabs and warps the pointer.
 * - macOS: `macos-drag-source`, an AppKit app that starts an `NSDraggingSession`
 *   from a real CoreGraphics mouse-down on its own window and moves the pointer
 *   with posted CoreGraphics drag events.
 * - Windows: `windows-drag-source`, a WinForms app that enters OLE `DoDragDrop`
 *   from a real `SendInput` mouse-down on its own window and moves the cursor
 *   with `SendInput`.
 */
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import { pathToFileURL } from 'node:url'

export type DragBackend = 'x11' | 'appkit' | 'ole'

export const dragBackend: DragBackend =
  process.platform === 'darwin' ? 'appkit' : process.platform === 'win32' ? 'ole' : 'x11'

const accepted = Object.freeze({ accepted: true, copy: true })

/** A `text/uri-list` payload for local files, CRLF terminated as XDND sources send it. */
function uris(...paths: string[]): string {
  return paths.map((path) => pathToFileURL(path).href + '\r\n').join('')
}

export interface DragEnvironment {
  output: string
  host: string
  source: string
  mode: 'development' | 'aot'
}

/** The evidence directory, host, drag source and mode every drag test needs. */
export function dragEnvironment(): DragEnvironment {
  const output = process.env['BUN_NATIVE_DRAG_DROP_EVIDENCE']
  const host = process.env['BUN_NATIVE_HOST']
  const source = process.env['BUN_NATIVE_DRAG_SOURCE']
  const mode = process.env['BUN_NATIVE_DRAG_DROP_MODE']
  if (
    !output ||
    !isAbsolute(output) ||
    !statSync(output).isDirectory() ||
    !host ||
    !isAbsolute(host) ||
    !source ||
    !isAbsolute(source) ||
    (mode !== 'development' && mode !== 'aot') ||
    (dragBackend === 'x11' && (!process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']))
  )
    throw new Error(
      'An evidence directory, host, OS drag source, mode and (on Linux) an isolated X11 display are required'
    )
  return { output, host, source, mode }
}

export type SourceReply = Record<string, unknown>

/** What the independent source process is and how it moves the pointer. */
export const sourceDescription: Record<DragBackend, string> = {
  x11: 'independent x11rb XDND v5 source process (xdnd-source), pointer grab and warp',
  appkit:
    'independent AppKit NSDraggingSession source process (macos-drag-source), CoreGraphics mouse-down, drag and Escape events',
  ole: 'independent WinForms OLE DoDragDrop source process (windows-drag-source), SendInput mouse-down, moves and release',
}

export class DragSource {
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'inherit'>
  private readonly lines: ReadableStreamDefaultReader<string>
  private buffer = ''
  readonly backend = dragBackend

  constructor(executable: string) {
    this.process = Bun.spawn([executable], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    this.lines = this.process.stdout.pipeThrough(new TextDecoderStream()).getReader()
  }

  /** One raw command; a reply carrying `error` fails the test. */
  async send(command: string): Promise<SourceReply> {
    this.process.stdin.write(command + '\n')
    await this.process.stdin.flush()
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        const reply = JSON.parse(line) as SourceReply
        if (typeof reply['error'] === 'string')
          throw new Error(`Drag source failed during ${command}: ${reply['error']}`)
        return reply
      }
      const { done, value } = await this.lines.read()
      if (done) throw new Error('Drag source exited during ' + command)
      this.buffer += value
    }
  }

  /** Target the owned window with this title and viewport size. */
  async find(title: string, width: number, height: number): Promise<void> {
    const reply = await this.send(
      this.backend === 'x11'
        ? 'find ' + title
        : 'find ' + JSON.stringify({ title, width, height, pid: process.pid })
    )
    assert.equal(reply['found'], true, JSON.stringify(reply))
  }

  async offerFiles(paths: string[]): Promise<void> {
    await this.send(
      this.backend === 'x11'
        ? 'offer uri ' + JSON.stringify(uris(...paths))
        : 'offer files ' + JSON.stringify(paths)
    )
  }

  async offerText(text: string): Promise<void> {
    await this.send('offer text ' + JSON.stringify(text))
  }

  /** Start a drag from the source and bring it over window-relative X,Y. */
  async enter(x: number, y: number): Promise<SourceReply> {
    const reply = await this.send(`enter ${x} ${y}`)
    if (this.backend === 'x11') assert.deepEqual(reply, { status: accepted, conversions: 1 })
    else assert.equal(reply['entered'], true, JSON.stringify(reply))
    return reply
  }

  async move(x: number, y: number): Promise<SourceReply> {
    const reply = await this.send(`move ${x} ${y}`)
    if (this.backend === 'x11') assert.deepEqual(reply, { status: accepted, conversions: 1 })
    else assert.equal(reply['moved'], true, JSON.stringify(reply))
    return reply
  }

  /**
   * Release the button over the current position. GPUI answers every file
   * drag it converted with copy, so the source's view is recorded, not trusted.
   */
  async drop(): Promise<SourceReply> {
    const reply = await this.send('drop')
    if (this.backend === 'x11') assert.deepEqual(reply, { finished: accepted })
    else assert.equal(reply['ended'], true, JSON.stringify(reply))
    return reply
  }

  /** The source cancels: XdndLeave, Escape in the AppKit session, or an OLE cancel. */
  async leave(): Promise<SourceReply> {
    const reply = await this.send('leave')
    if (this.backend === 'x11') assert.deepEqual(reply, { left: true })
    else assert.deepEqual([reply['ended'], reply['operation']], [true, 'none'])
    return reply
  }

  async close(): Promise<void> {
    this.process.stdin.end()
    assert.equal(await this.process.exited, 0)
  }
}

export async function until(description: string, predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for ' + description)
    await Bun.sleep(5)
  }
}

/** Drives the independent `xdnd-source` X11 client, one command per line. */
import assert from 'node:assert/strict'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import { pathToFileURL } from 'node:url'

export const accepted = Object.freeze({ accepted: true, copy: true })

/** A `text/uri-list` payload for local files, CRLF terminated as XDND sources send it. */
export function uris(...paths: string[]): string {
  return paths.map((path) => pathToFileURL(path).href + '\r\n').join('')
}

export class XdndSource {
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'inherit'>
  private readonly lines: ReadableStreamDefaultReader<string>
  private buffer = ''

  constructor(executable: string) {
    this.process = Bun.spawn([executable], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    this.lines = this.process.stdout.pipeThrough(new TextDecoderStream()).getReader()
  }

  async send(command: string): Promise<Record<string, unknown>> {
    this.process.stdin.write(command + '\n')
    await this.process.stdin.flush()
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        return JSON.parse(line) as Record<string, unknown>
      }
      const { done, value } = await this.lines.read()
      if (done) throw new Error('XDND source exited during ' + command)
      this.buffer += value
    }
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

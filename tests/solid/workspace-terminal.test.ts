import { describe, expect, test } from 'bun:test'
import type { NativeProcess, ProcessEvent } from '@bun-native/core'
import {
  MAX_COMMAND_LENGTH,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_LINES,
  TerminalSession,
} from '../../examples/shared/terminal.ts'

type Listener = (event: ProcessEvent) => void | Promise<void>

class FakeProcess {
  readonly writes: string[] = []
  readonly signals: string[] = []
  released = 0
  exit: { code: number } | { signal: number } | undefined
  private sequence = 0
  readonly handle: NativeProcess

  constructor(private readonly listener: Listener) {
    this.handle = handleFor(this)
  }

  output(text: string | Uint8Array) {
    return this.listener({
      type: 'process_output',
      sequence: ++this.sequence,
      process: this.handle,
      stream: 'terminal',
      bytes: typeof text === 'string' ? new TextEncoder().encode(text) : text,
      signal: new AbortController().signal,
    })
  }

  exited(exit: { code: number } | { signal: number }) {
    this.exit = exit
    return this.listener({
      type: 'process_exited',
      sequence: ++this.sequence,
      process: this.handle,
      exit,
      signal: new AbortController().signal,
    })
  }
}

function handleFor(fake: FakeProcess): NativeProcess {
  return {
    executable: 'shell',
    terminal: true,
    get active() {
      return fake.released === 0
    },
    get exit() {
      return fake.exit
    },
    write: async (bytes) => {
      fake.writes.push(new TextDecoder().decode(bytes))
    },
    closeInput: async () => {},
    resize: async () => {},
    signal: async (signal) => {
      fake.signals.push(signal)
    },
    release: async () => {
      fake.released++
    },
  }
}

function session() {
  const processes: FakeProcess[] = []
  const terminal = new TerminalSession(async (listener) => {
    const child = new FakeProcess(listener)
    processes.push(child)
    return child.handle
  })
  return { terminal, processes }
}

const texts = (terminal: TerminalSession) => terminal.current.lines.map((line) => line.text)

describe('workspace terminal session (fake owned process)', () => {
  test('streams lines, keeps the prompt as a partial line and runs commands', async () => {
    const { terminal, processes } = session()
    const seen: string[] = []
    terminal.subscribe((state) => seen.push(state.status))
    await terminal.start()
    expect(terminal.current.status).toBe('running')
    const child = processes[0]!
    await child.output('hello\r\nworld\r\n$ ')
    expect(texts(terminal)).toEqual(['hello', 'world'])
    expect(terminal.current.partial).toBe('$ ')
    expect(await terminal.run('echo hi')).toBe(true)
    expect(child.writes).toEqual(['echo hi\r'])
    expect(await terminal.run('a\nb')).toBe(false)
    expect(await terminal.run('x'.repeat(MAX_COMMAND_LENGTH + 1))).toBe(false)
    expect(await terminal.interrupt()).toBe(true)
    expect(child.writes).toEqual(['echo hi\r', '\u0003'])
    expect(seen).toEqual(['starting', 'running', 'running'])
  })

  test('removes escapes split across chunks, applies carriage returns and splits UTF-8 safely', async () => {
    const { terminal, processes } = session()
    await terminal.start()
    const child = processes[0]!
    await child.output('\u001b[1;3')
    await child.output('2mred\u001b[0m\r\n')
    await child.output('50%\r100%\r\n')
    await child.output('\u001b]0;title\u0007bell\u0007\r\n')
    const euro = new TextEncoder().encode('€\n')
    await child.output(euro.slice(0, 1))
    await child.output(euro.slice(1))
    expect(texts(terminal)).toEqual(['red', '100%', 'bell', '€'])
    // A pseudo console moves the cursor to the next row instead of a newline.
    await child.output('C:\\>echo ok\u001b[3;1Hok\u001b[4')
    await child.output(';1HC:\\>')
    expect(texts(terminal).slice(4)).toEqual(['C:\\>echo ok', 'ok'])
    expect(terminal.current.partial).toBe('C:\\>')
  })

  test('bounds scrollback and line width with stable line identity', async () => {
    const { terminal, processes } = session()
    await terminal.start()
    const child = processes[0]!
    await child.output('x'.repeat(MAX_TERMINAL_COLUMNS + 50) + '\n')
    expect(texts(terminal)[0]).toHaveLength(MAX_TERMINAL_COLUMNS)
    for (let index = 0; index < MAX_TERMINAL_LINES + 10; index++) await child.output(index + '\n')
    const lines = terminal.current.lines
    expect(lines).toHaveLength(MAX_TERMINAL_LINES)
    expect(lines.at(-1)!.text).toBe(String(MAX_TERMINAL_LINES + 9))
    expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length)
    expect(lines.every((line, index) => index === 0 || line.id > lines[index - 1]!.id)).toBe(true)
  })

  test('an exit is reported once and releases the exited process', async () => {
    const { terminal, processes } = session()
    await terminal.start()
    const child = processes[0]!
    await child.exited({ code: 3 })
    expect(terminal.current).toMatchObject({ status: 'exited', detail: 'exit 3' })
    expect(child.released).toBe(1)
    expect(await terminal.run('echo')).toBe(false)
    expect(await terminal.interrupt()).toBe(false)
  })

  test('restart ignores late output and exits from the previous shell', async () => {
    const { terminal, processes } = session()
    await terminal.start()
    await processes[0]!.output('old\n')
    await terminal.restart()
    expect(processes).toHaveLength(2)
    expect(processes[0]!.released).toBe(1)
    await processes[0]!.output('late\n')
    await processes[0]!.exited({ signal: 9 })
    expect(terminal.current.status).toBe('running')
    await processes[1]!.output('new\n')
    expect(texts(terminal)).toEqual(['old', 'new'])
  })

  test('a failed start is reported and release refuses later starts', async () => {
    let fail = true
    const processes: FakeProcess[] = []
    const terminal = new TerminalSession(async (listener) => {
      if (fail) throw new Error('permission_denied')
      const child = new FakeProcess(listener)
      processes.push(child)
      return child.handle
    })
    await terminal.start()
    expect(terminal.current).toMatchObject({ status: 'failed', detail: 'permission_denied' })
    fail = false
    await terminal.start()
    expect(terminal.current.status).toBe('running')
    await terminal.release()
    await terminal.release()
    expect(processes[0]!.released).toBe(1)
    expect(terminal.current.status).toBe('released')
    await expect(terminal.start()).rejects.toThrow('released')
  })

  test('a release while the shell is starting releases it when it arrives', async () => {
    let resolve!: (process: NativeProcess) => void
    let child: FakeProcess | undefined
    const terminal = new TerminalSession((listener) => {
      child = new FakeProcess(listener)
      return new Promise((done) => (resolve = done))
    })
    const starting = terminal.start()
    const releasing = terminal.release()
    resolve(child!.handle)
    await starting
    await releasing
    expect(child!.released).toBe(1)
    expect(terminal.current.status).toBe('released')
  })
})

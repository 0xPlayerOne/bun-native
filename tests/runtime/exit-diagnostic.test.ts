import { describe, expect, test } from 'bun:test'
import {
  exitDiagnostic,
  MAX_DIAGNOSTIC_TAIL,
  NativeHostExitError,
} from '../../packages/runtime/src/exit-diagnostic.ts'

// Unit coverage for the #247 exit record: classification, clipping, bounds and
// redaction without a subprocess. The headless peer cases live in host-exit.test.ts.
function diagnose(
  stderr: string,
  overrides: Partial<Parameters<typeof exitDiagnostic>[0]> = {}
): ReturnType<typeof exitDiagnostic> {
  return exitDiagnostic({
    exitCode: 1,
    signal: null,
    phase: 'running',
    pendingRequests: 0,
    stderr,
    stderrClipped: false,
    environment: {},
    ...overrides,
  })
}

describe('exit diagnostic classification', () => {
  test('a panic report wins over a signal, then a signal over an exit code', () => {
    const panic = "thread 'main' panicked at src/main.rs:7:5:\nboom\n"
    expect(diagnose(panic, { exitCode: null, signal: 'SIGABRT' })).toMatchObject({
      reason: 'panic',
      panicLocation: 'src/main.rs:7:5',
      exitCode: null,
      signal: 'SIGABRT',
    })
    expect(diagnose('killed\n', { exitCode: null, signal: 'SIGKILL' })).toMatchObject({
      reason: 'signal',
      panicLocation: null,
    })
    expect(diagnose('', { exitCode: 2 })).toMatchObject({
      reason: 'exit',
      exitCode: 2,
      signal: null,
      panicLocation: null,
      stderrTail: '',
      stderrTruncated: false,
    })
  })

  test('a panic location without line and column is not reported', () => {
    expect(diagnose('panicked at src/main.rs\n')).toMatchObject({
      reason: 'exit',
      panicLocation: null,
    })
  })

  test('the record is frozen and carries the transport state it was given', () => {
    const diagnostic = diagnose('bye\n', {
      phase: 'stopping',
      pendingRequests: 3,
    })
    expect(Object.isFrozen(diagnostic)).toBe(true)
    expect(diagnostic).toEqual({
      reason: 'exit',
      exitCode: 1,
      signal: null,
      phase: 'stopping',
      pendingRequests: 3,
      panicLocation: null,
      stderrTail: 'bye',
      stderrTruncated: false,
    })
  })

  test('the error names its status and carries the redacted tail only', () => {
    const diagnostic = diagnose('API_KEY=abcdef\n', { exitCode: 9 })
    const error = new NativeHostExitError(diagnostic, 9)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NativeHostExitError')
    expect(error.diagnostic).toBe(diagnostic)
    expect(error.message).toBe('Native host exited unexpectedly (9). API_KEY=[redacted]')
  })
})

describe('exit diagnostic bounds', () => {
  test('keeps the last 32 lines and marks the dropped beginning', () => {
    const stderr = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n') + '\n\n'
    const diagnostic = diagnose(stderr)
    const lines = diagnostic.stderrTail.split('\n')
    expect(lines).toHaveLength(32)
    expect(lines[0]).toBe('line 8')
    expect(lines.at(-1)).toBe('line 39')
    expect(diagnostic.stderrTruncated).toBe(true)
  })

  test('exactly 32 lines are not truncated', () => {
    const stderr = Array.from({ length: 32 }, (_, index) => `line ${index}`).join('\n')
    expect(diagnose(stderr)).toMatchObject({ stderrTruncated: false })
  })

  test('clips an over-long tail to its last characters', () => {
    const stderr = 'a '.repeat(MAX_DIAGNOSTIC_TAIL) + 'end'
    const diagnostic = diagnose(stderr)
    expect(diagnostic.stderrTail).toHaveLength(MAX_DIAGNOSTIC_TAIL)
    expect(diagnostic.stderrTail).toEndWith(' end')
    expect(diagnostic.stderrTruncated).toBe(true)
  })

  test('a clipped capture drops its first partial line before redaction', () => {
    // The fragment is the end of a secret that no longer matches its env value.
    const diagnostic = diagnose('ret-fragment\nnext line\n', {
      stderrClipped: true,
      environment: { SECRET: 'full-secret-fragment' },
    })
    expect(diagnostic.stderrTail).toBe('next line')
    expect(diagnostic.stderrTruncated).toBe(true)
  })

  test('a clipped capture without a line break keeps nothing', () => {
    const diagnostic = diagnose('ret-fragment-without-newline', {
      stderrClipped: true,
    })
    expect(diagnostic.stderrTail).toBe('')
    expect(diagnostic.stderrTruncated).toBe(true)
  })

  test('a panic report kept while capturing leads a clipped backtrace tail', () => {
    const header = "thread 'main' panicked at native/gpui-host/src/session.rs:710:17:"
    const frames = Array.from({ length: 60 }, (_, index) => `  ${index}: frame::${index}`)
    const diagnostic = diagnose(`ure#0}}\n${frames.join('\n')}\n`, {
      exitCode: 101,
      stderrClipped: true,
      panicReport: `${header}\nTOKEN=abc boom`,
    })
    expect(diagnostic).toMatchObject({
      reason: 'panic',
      panicLocation: 'native/gpui-host/src/session.rs:710:17',
      stderrTruncated: true,
    })
    const tail = diagnostic.stderrTail.split('\n')
    expect(tail.slice(0, 3)).toEqual([header, 'TOKEN=[redacted] boom', '…'])
    expect(tail.at(-1)).toBe('  59: frame::59')
    expect(tail.length).toBeLessThanOrEqual(32)
    expect(diagnostic.stderrTail.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_TAIL)
    expect(diagnostic.stderrTail).not.toContain('ure#0')
    // A report the tail still holds is not repeated.
    expect(diagnose(`${header}\nboom\n`, { panicReport: `${header}\nboom` }).stderrTail).toBe(
      `${header}\nboom`
    )
  })
})

describe('exit diagnostic redaction', () => {
  test('replaces inherited environment values, longest first and literally', () => {
    const diagnostic = diagnose('open (a+b)*c? failed in /home/user-long/dir\n', {
      environment: {
        PATTERN: '(a+b)*c?',
        HOME: '/home/user',
        PROJECT: '/home/user-long/dir',
        UNSET: undefined,
      },
    })
    expect(diagnostic.stderrTail).toBe('open [redacted] failed in [redacted]')
  })

  test('keeps short and blank environment values, which would over-match', () => {
    const diagnostic = diagnose('value 12345 and spaces\n', {
      environment: { SHORT: '12345', BLANK: '        ' },
    })
    expect(diagnostic.stderrTail).toBe('value 12345 and spaces')
  })

  test('replaces assignments, including quoted values', () => {
    const diagnostic = diagnose(`A=1 name="two words" other='single quoted' x=y\n`)
    expect(diagnostic.stderrTail).toBe('A=[redacted] name=[redacted] other=[redacted] x=[redacted]')
  })

  test.each([
    ['Authorization: Bearer abc', 'Authorization: [redacted] abc'],
    ['bearer abc', 'bearer [redacted]'],
    ['token: "two words"', 'token: [redacted]'],
    ['secret  hunter2', 'secret  [redacted]'],
    ['password: hunter2', 'password: [redacted]'],
    ['passwd hunter2', 'passwd [redacted]'],
    ['api_key: k', 'api_key: [redacted]'],
    ['api-key k', 'api-key [redacted]'],
    ['apikey k', 'apikey [redacted]'],
    ['Cookie: session', 'Cookie: [redacted]'],
  ])('replaces the credential value in %p', (input, output) => {
    expect(diagnose(input).stderrTail).toBe(output)
  })

  test('replaces long opaque tokens but keeps shorter words', () => {
    const token = 'A1b2-C3d4+'.repeat(4)
    const diagnostic = diagnose(`got ${token} and ${'x'.repeat(31)}\n`)
    expect(diagnostic.stderrTail).toBe(`got [redacted] and ${'x'.repeat(31)}`)
  })

  test('strips control characters other than newline and tab', () => {
    const diagnostic = diagnose('\u001b[31mred\u001b[0m\tcol\r\nnext\u0000\n')
    expect(diagnostic.stderrTail).toBe('[31mred[0m\tcol\nnext')
  })

  test('reports a panic location found after redaction', () => {
    const diagnostic = diagnose("thread 'main' panicked at src/lib.rs:1:2:\nTOKEN=abc\n")
    expect(diagnostic).toMatchObject({
      reason: 'panic',
      panicLocation: 'src/lib.rs:1:2',
    })
    expect(diagnostic.stderrTail).toBe(
      "thread 'main' panicked at src/lib.rs:1:2:\nTOKEN=[redacted]"
    )
  })
})

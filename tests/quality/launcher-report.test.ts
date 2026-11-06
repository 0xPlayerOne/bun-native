import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STREAM_LIMIT, boundedTail, readLauncherReport } from '../native/launcher-report.ts'

const directory = mkdtempSync(join(tmpdir(), 'launcher-report-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const run = { exitCode: 0, stdout: 'portal noise\nAuthorization required', stderr: 'stderr text' }

test('parses the last line of the report file and ignores the launcher streams', () => {
  const file = join(directory, 'ok.json')
  writeFileSync(file, 'warm-up line\n{"status":"passed"}\n')
  expect(readLauncherReport<{ status: string }>(run, file, 'App')).toEqual({ status: 'passed' })
})

test('a missing report names the exit status and both streams separately', () => {
  const file = join(directory, 'missing.json')
  let message = ''
  try {
    readLauncherReport({ ...run, exitCode: 3 }, file, 'App')
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toContain('App wrote no report.')
  expect(message).toContain('launcher exit status: 3')
  expect(message).toContain('not written')
  expect(message).toContain('--- launcher stdout (tail) ---\nportal noise\nAuthorization required')
  expect(message).toContain('--- launcher stderr (tail) ---\nstderr text')
})

test('an empty report and a killed launcher are reported as such', () => {
  const file = join(directory, 'empty.json')
  writeFileSync(file, '\n')
  expect(() => readLauncherReport({ ...run, exitCode: null }, file, 'App')).toThrow(
    /none \(killed or timed out\)/
  )
})

test('an unparseable report keeps the parse error as the cause and bounds every stream', () => {
  const file = join(directory, 'bad.json')
  writeFileSync(file, `{"status":\n${'x'.repeat(STREAM_LIMIT * 2)}`)
  const long = { exitCode: 0, stdout: 'o'.repeat(STREAM_LIMIT * 3), stderr: 'e' }
  let caught: unknown
  try {
    readLauncherReport(long, file, 'App')
  } catch (error) {
    caught = error
  }
  const error = caught as Error
  expect(error.message).toContain('App report is not JSON')
  expect(error.cause).toBeInstanceOf(Error)
  expect(error.message).toContain(`[${STREAM_LIMIT * 2} earlier characters omitted]`)
  expect(error.message.length).toBeLessThan(STREAM_LIMIT * 4)
})

test('boundedTail keeps short text intact and marks what a long text lost', () => {
  expect(boundedTail('short')).toBe('short')
  expect(boundedTail('abcdef', 3)).toBe('[3 earlier characters omitted]\ndef')
})

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { testPython } from '../scripts/test-environment.ts'

test('test environment preserves the explicitly configured interpreter', () => {
  for (const configured of ['python3', '/custom/venv/bin/python', '']) {
    expect(
      testPython('/repo', 'linux', configured, undefined, () => {
        throw new Error('must not discover')
      })
    ).toBe(configured)
  }
})

test('test environment selects the contributor venv without canonicalizing its executable', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const expected =
      platform === 'win32'
        ? join('/repo', '.venv', 'Scripts', 'python.exe')
        : join('/repo', '.venv', 'bin', 'python')
    expect(
      testPython('/repo', platform, undefined, undefined, (path) => {
        expect(path).toBe(expected)
        return '/underlying/system/python'
      })
    ).toBe(expected)
  }
})

test('an activated environment precedes the repository environment', () => {
  expect(testPython('/repo', 'linux', undefined, '/active', () => '/active/bin/python')).toBe(
    join('/active', 'bin', 'python')
  )
})

test('a missing virtualenv leaves ordinary caller PATH selection unchanged', () => {
  expect(testPython('/repo', 'linux', undefined, undefined, () => null)).toBeUndefined()
})

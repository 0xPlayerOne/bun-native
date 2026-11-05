import { describe, expect, test } from 'bun:test'
import { lockControlArguments } from '../../scripts/quality/standalone-lock-control.ts'

const paths = ['--input', '/cohort', '--prior', '/prior']

describe('standalone lock-control arguments', () => {
  test('keeps a trailing-slash outdir on the named directory', () => {
    expect(lockControlArguments([...paths, '--outdir', '/x/out/']).outdir).toBe('/x/out')
    expect(lockControlArguments([...paths, '--outdir', '/x/']).outdir).toBe('/x')
    expect(lockControlArguments([...paths, '--outdir', '/x/out']).outdir).toBe('/x/out')
  })

  test('rejects a root or relative outdir with the usage error', () => {
    for (const outdir of ['/', '//', '/x/..', 'out', 'out/'])
      expect(() => lockControlArguments([...paths, '--outdir', outdir])).toThrow(/^Usage: /)
    expect(() => lockControlArguments(paths)).toThrow(/^Usage: /)
  })
})

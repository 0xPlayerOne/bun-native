import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const script = resolve(import.meta.dir, '../../scripts/quality/standalone-lock-control.ts')
const paths = ['--input', '/cohort', '--prior', '/prior']

// The parser is evaluated in a child Bun so that the rest of this release-only
// script, which needs the pinned compiler and a retained cohort, stays out of
// the per-file coverage report.
function parsed(argumentLists: string[][]): ({ outdir: string } | { error: string })[] {
  const source =
    `const { lockControlArguments } = await import(${JSON.stringify(script)})\n` +
    `console.log(JSON.stringify(${JSON.stringify(argumentLists)}.map((args) => {\n` +
    '  try { return { outdir: lockControlArguments(args).outdir } }\n' +
    '  catch (error) { return { error: String(error.message) } }\n' +
    '})))'
  const result = Bun.spawnSync([process.execPath, '--eval', source], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString())
}

describe('standalone lock-control arguments', () => {
  test('keeps a trailing-slash outdir on the named directory', () => {
    expect(
      parsed([
        [...paths, '--outdir', '/x/out/'],
        [...paths, '--outdir', '/x/'],
        [...paths, '--outdir', '/x/out'],
      ])
    ).toEqual([
      { outdir: resolve('/x/out') },
      { outdir: resolve('/x') },
      { outdir: resolve('/x/out') },
    ])
  })

  test('rejects a root or relative outdir with the usage error', () => {
    const rejected = [
      ...['/', '//', '/x/..', 'out', 'out/'].map((outdir) => [...paths, '--outdir', outdir]),
      paths,
    ]
    for (const result of parsed(rejected))
      expect(result).toMatchObject({
        error: expect.stringMatching(/^Usage: /),
      })
  })
})

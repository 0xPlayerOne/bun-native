import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { trackedFiles } from '../../scripts/quality/doc-links.ts'

// Docs, examples and release notes state measured facts (#254): a comparative
// performance claim must cite a recorded measurement on the same line, and
// every example is exercised by an automated test.

const ROOT = resolve(import.meta.dir, '../..')

const CLAIM =
  /\b(?:faster|slower|smaller|lighter|leaner|quicker) than\b|\b(?:blazing|lightning)[- ]?fast\b|\boutperform|\bbest[- ]in[- ]class\b|\b\d+(?:\.\d+)?\s*[x×] (?:faster|smaller|lighter|less)\b/i
const EVIDENCE =
  /\]\((?:\.\.\/|\.\/)*(?:benchmarks|docs\/evidence)\/|https:\/\/github\.com\/0xPlayerOne\/bun-native\/actions\/runs\/\d+/

/** Lines that make a comparative claim without citing a recorded measurement. */
function unsupportedClaims(files: Record<string, string>): string[] {
  const out: string[] = []
  for (const [path, text] of Object.entries(files)) {
    // Measurement records describe their own runs.
    if (path.startsWith('benchmarks/') || path.startsWith('docs/evidence/')) continue
    text.split('\n').forEach((line, index) => {
      if (CLAIM.test(line) && !EVIDENCE.test(line)) out.push(`${path}:${index + 1}: ${line.trim()}`)
    })
  }
  return out
}

describe('measured-claims rule', () => {
  test('flags an uncited comparison and accepts one that cites a benchmark record or run', () => {
    expect(
      unsupportedClaims({
        'README.md': [
          'Bun Native is 3x faster than Electron.',
          'AOT starts faster than development ([record](benchmarks/comparison/results/x/README.md)).',
          'Smaller than the JIT build, see https://github.com/0xPlayerOne/bun-native/actions/runs/123.',
          'A plain sentence.',
        ].join('\n'),
        'benchmarks/BRIDGE.md': 'values are noisier and slower than hosted CI',
        'CHANGELOG.md': '* blazing fast startup',
      })
    ).toEqual([
      'README.md:1: Bun Native is 3x faster than Electron.',
      'CHANGELOG.md:1: * blazing fast startup',
    ])
  })

  test('tracked docs, examples and release notes make no uncited comparative claim', () => {
    const files = Object.fromEntries(
      trackedFiles(ROOT)
        .filter((path) => path.endsWith('.md'))
        .map((path) => [path, readFileSync(join(ROOT, path), 'utf8')])
    )
    expect(Object.keys(files)).toContain('CHANGELOG.md')
    expect(unsupportedClaims(files)).toEqual([])
  })
})

test('every example is exercised by a headless test or a native CI entry', () => {
  const buildWindow = readFileSync(join(ROOT, 'experiments/aot-gpui/build-window.ts'), 'utf8')
  const nativeLinux = readFileSync(join(ROOT, '.github/workflows/native-linux.yml'), 'utf8')
  const testSources = readdirSync(join(ROOT, 'tests/examples'))
    .map((name) => readFileSync(join(ROOT, 'tests/examples', name), 'utf8'))
    .join('\n')
  const examples = readdirSync(join(ROOT, 'examples'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  expect(examples.length).toBeGreaterThan(0)
  const uncovered = examples.filter((name) => {
    expect(existsSync(join(ROOT, 'examples', name, 'README.md'))).toBe(true)
    const headless = testSources.includes(`examples/${name}/`)
    // A build-window entry that compiles this example and that native CI runs.
    const entries = [
      ...buildWindow.matchAll(new RegExp(`'?([\\w-]+)'?: 'examples/${name}/main\\.tsx?'`, 'g')),
    ].map((match) => match[1]!)
    const native = entries.some((entry) =>
      new RegExp(`(?:^|[\\s"'])${entry}(?:[\\s"';]|$)`, 'm').test(nativeLinux)
    )
    return !headless && !native
  })
  expect(uncovered).toEqual([])
})

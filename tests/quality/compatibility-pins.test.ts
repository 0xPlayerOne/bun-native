import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@bun-native/protocol'
import rootManifest from '../../package.json'
import reactManifest from '../../packages/react/package.json'
import solidManifest from '../../packages/solid/package.json'
import toolchain from '../../toolchain.json'

const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

const heading = '## Exact pins'

/** Rows of the compatibility matrix's pin table, keyed by component name. */
function documentedPins(markdown: string): Map<string, string> {
  const start = markdown.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`docs/compatibility.md has no "${heading}" section`)
  const body = markdown.slice(start + heading.length + 2)
  const end = body.search(/\n## /)
  const section = end < 0 ? body : body.slice(0, end)
  const pins = new Map<string, string>()
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 4 || cells[0] !== '') continue
    const name = cells[1]?.match(/^`([^`]+)`$/)?.[1]
    const value = cells[2]?.match(/^`([^`]+)`$/)?.[1]
    if (name === undefined || value === undefined) continue
    if (pins.has(name)) throw new Error(`duplicate documented pin ${name}`)
    pins.set(name, value)
  }
  return pins
}

/** The single value every named repository source agrees on, or a failure. */
function agreed(name: string, values: readonly (string | undefined)[]): string {
  const distinct = new Set(values)
  if (distinct.size !== 1 || values[0] === undefined) {
    throw new Error(`repository sources disagree on ${name}: ${JSON.stringify(values)}`)
  }
  return values[0]
}

function cargoGitRevisions(manifest: string, crate: string): string[] {
  const pattern = new RegExp(`^${crate}\\s*=\\s*\\{[^}\\n]*\\brev\\s*=\\s*"([0-9a-f]{40})"`, 'gm')
  return [...manifest.matchAll(pattern)].map((match) => match[1] ?? '')
}

function rustProtocolVersion(): string | undefined {
  return read('native/protocol/src/wire.rs').match(
    /^pub const PROTOCOL_VERSION: u32 = (\d+);$/m
  )?.[1]
}

function repositoryPins(): Map<string, string> {
  const hostManifest = read('native/gpui-host/Cargo.toml')
  const gpuiRevisions = [
    toolchain.gpui.revision,
    ...cargoGitRevisions(hostManifest, 'gpui'),
    ...cargoGitRevisions(hostManifest, 'gpui_platform'),
  ]
  if (gpuiRevisions.length !== 3)
    throw new Error('native/gpui-host must pin gpui and gpui_platform')
  return new Map([
    ['bun', agreed('bun', [toolchain.bun.version, rootManifest.engines.bun])],
    ['bun revision', toolchain.bun.revision],
    ['rust', toolchain.rust.version],
    ['gpui revision', agreed('gpui revision', gpuiRevisions)],
    ['gpui', toolchain.gpui.version],
    [
      'solid-js',
      agreed('solid-js', [
        solidManifest.dependencies['solid-js'],
        rootManifest.devDependencies['solid-js'],
      ]),
    ],
    ['babel-preset-solid', rootManifest.devDependencies['babel-preset-solid']],
    ['@babel/core', rootManifest.devDependencies['@babel/core']],
    [
      'react',
      agreed('react', [reactManifest.dependencies.react, rootManifest.devDependencies.react]),
    ],
    ['react-reconciler', reactManifest.dependencies['react-reconciler']],
    [
      'native protocol',
      agreed('native protocol', [String(PROTOCOL_VERSION), rustProtocolVersion()]),
    ],
  ])
}

test('the compatibility matrix documents exactly the repository pins', () => {
  const documented = documentedPins(read('docs/compatibility.md'))
  expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(repositoryPins()))
})

test('the pin table parser rejects a missing section and duplicate rows', () => {
  expect(() => documentedPins('# Title\n')).toThrow('no "## Exact pins" section')
  const duplicated = `${heading}\n\n| \`bun\` | \`1\` | a |\n| \`bun\` | \`2\` | b |\n`
  expect(() => documentedPins(`\n${duplicated}`)).toThrow('duplicate documented pin bun')
})

test('the pin table parser stops at the next section', () => {
  const markdown = `\n${heading}\n\n| \`bun\` | \`1\` | a |\n\n## Other\n\n| \`rust\` | \`2\` | b |\n`
  expect(Object.fromEntries(documentedPins(markdown))).toEqual({ bun: '1' })
})

test('disagreeing repository sources fail instead of choosing one', () => {
  expect(agreed('x', ['1', '1'])).toBe('1')
  expect(() => agreed('x', ['1', '2'])).toThrow('repository sources disagree on x')
  expect(() => agreed('x', [undefined])).toThrow('repository sources disagree on x')
})

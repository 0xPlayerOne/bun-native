import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { version as babelVersion } from '@babel/core'
import solidPresetManifest from 'babel-preset-solid/package.json'
import { transformSolid } from '@bun-native/solid/build'

// These tests establish the JSX transformation boundary, not native rendering.
describe('official Solid universal JSX transform', () => {
  test('installed compiler satisfies the published preset peer contract', () => {
    expect(
      Bun.semver.satisfies(babelVersion, solidPresetManifest.peerDependencies['@babel/core'])
    ).toBe(true)
  })

  test('installed compiler satisfies the preset-resolved JSX plugin peer contract', () => {
    // The preset delegates compilation to the JSX plugin it resolves, whose Babel peer is narrower.
    const fromPreset = createRequire(require.resolve('babel-preset-solid/package.json'))
    const pluginManifest: unknown = fromPreset('babel-plugin-jsx-dom-expressions/package.json')
    expect(Bun.semver.satisfies(babelVersion, babelPeerRange(pluginManifest))).toBe(true)
  })

  test('keeps automatic Babel major updates excluded until #316 qualifies a pairing', async () => {
    const config: unknown = Bun.YAML.parse(
      await Bun.file(new URL('../../.github/dependabot.yml', import.meta.url)).text()
    )
    expect(bunEcosystemIgnores(config)).toContainEqual({
      'dependency-name': '@babel/core',
      'update-types': ['version-update:semver-major'],
    })
  })

  test('uses the native helper module for reactive native elements and control flow', () => {
    const output = transformSolid(
      `import { For } from 'solid-js';
       export const List = (props: { items: string[] }) =>
         <box><text>{props.items.length}</text>
           <For each={props.items}>{item => <text text={item}/>}</For>
         </box>`,
      'native-list.tsx'
    )
    expect(output).toContain('from "@bun-native/solid"')
    expect(output).toContain('createElement')
    expect(output).toContain('"box"')
    expect(output).not.toContain('solid-js/web')
    expect(output).not.toContain('document.')
    expect(output).not.toContain('createElementNS')
  })

  test('reports invalid JSX instead of passing untransformed source to another renderer', () => {
    expect(() => transformSolid('const view = <box>', 'invalid.tsx')).toThrow()
  })
})

function babelPeerRange(manifest: unknown): string {
  if (typeof manifest !== 'object' || manifest === null || !('peerDependencies' in manifest)) {
    throw new Error('JSX plugin manifest declares no peer dependencies')
  }
  const peers = manifest.peerDependencies
  if (typeof peers !== 'object' || peers === null || !('@babel/core' in peers)) {
    throw new Error('JSX plugin manifest declares no @babel/core peer')
  }
  const range = peers['@babel/core']
  if (typeof range !== 'string') throw new Error('JSX plugin @babel/core peer is not a range')
  return range
}

function bunEcosystemIgnores(config: unknown): unknown[] {
  if (typeof config !== 'object' || config === null || !('updates' in config)) return []
  const { updates } = config
  if (!Array.isArray(updates)) return []
  const bun: unknown = updates.find(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'package-ecosystem' in entry &&
      entry['package-ecosystem'] === 'bun'
  )
  if (typeof bun !== 'object' || bun === null || !('ignore' in bun)) return []
  return Array.isArray(bun.ignore) ? bun.ignore : []
}

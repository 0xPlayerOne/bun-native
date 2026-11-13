import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/** Workspace crates plus every vendored file a recorded bun-native patch adds or changes. */
function expectedScope(): string[] {
  const members = [
    ...read('Cargo.toml')
      .split('members')[1]!
      .split(']')[0]!
      .matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]!)
  const vendor: string[] = []
  for (const crate of readdirSync(join(root, 'native/vendor')).sort()) {
    const dir = `native/vendor/${crate}/bun-native`
    const upstream = JSON.parse(read(`${dir}/upstream.json`)) as {
      patched?: string[]
      added?: string[]
      patches: Record<string, string>
    }
    const files = new Set([...(upstream.patched ?? []), ...(upstream.added ?? [])])
    if (files.size === 0) {
      for (const patch of Object.keys(upstream.patches)) {
        for (const line of read(`${dir}/${patch}`).split('\n')) {
          if (!line.startsWith('+++ b/')) continue
          const path = line.slice(6).trim()
          files.add(path.startsWith(`${crate}/`) ? path.slice(crate.length + 1) : path)
        }
      }
    }
    vendor.push(...[...files].sort().map((file) => `native/vendor/${crate}/${file}`))
  }
  return [...members, ...vendor]
}

const scopes = (text: string) =>
  [...text.matchAll(/native\/protocol,[^"'\\\]]+/g)].map((match) => match[0].split(','))

test('every CodeQL Rust scope is our crates plus the patched vendor files', () => {
  const expected = expectedScope()
  for (const path of expected) expect(existsSync(join(root, path))).toBe(true)
  const found = [
    ...scopes(read('.github/workflows/bun-native.yml')),
    ...scopes(read('.github/workflows/codeql.yml')),
    ...scopes(read('.github/code-foundry.yml')),
  ]
  // bun-native.yml carries it twice (reusable input and the analysis plan).
  expect(found).toHaveLength(4)
  for (const scope of found) expect(scope).toEqual(expected)
})

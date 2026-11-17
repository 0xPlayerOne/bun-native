import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  audienceFor,
  classify,
  escapePackageName,
  exchangeUrl,
  formatResult,
  probe,
  registryPackages,
} from '../../scripts/quality/npm-trusted-publishers.ts'

describe('npm trusted publisher probe', () => {
  // npm's own client escapes with npm-package-arg's escapedName, which keeps
  // the `@` and lowercases the scope separator. encodeURIComponent would send
  // `%40scope%2Fname` instead, so the path must not be built that way.
  test('escapes a scoped package the way npm client does', () => {
    expect(escapePackageName('@bun-native/cli')).toBe('@bun-native%2fcli')
    expect(escapePackageName('left-pad')).toBe('left-pad')
    expect(escapePackageName('@bun-native/cli')).not.toBe(encodeURIComponent('@bun-native/cli'))
  })

  test('asks the registry endpoint npm publish uses', () => {
    expect(exchangeUrl('https://registry.npmjs.org/', '@bun-native/cli')).toBe(
      'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@bun-native%2fcli'
    )
  })

  test('requests the audience npm derives from the registry host', () => {
    expect(audienceFor('https://registry.npmjs.org/')).toBe('npm:registry.npmjs.org')
    expect(audienceFor('https://registry.example.test/sub/path')).toBe('npm:registry.example.test')
  })

  test('only an exchanged token counts as an accepted publisher', () => {
    expect(classify('@bun-native/cli', 200, '{"token":"short-lived"}').accepted).toBe(true)
    for (const status of [401, 403, 404, 422, 500])
      expect(classify('@bun-native/cli', status, '{"error":"no publisher"}').accepted).toBe(false)
  })

  test('keeps a registry status in the reported detail', () => {
    expect(formatResult(classify('@bun-native/cli', 200, ''))).toStartWith('OK    @bun-native/cli')
    const rejected = formatResult(classify('@bun-native/core', 404, '{"error":"Not found"}'))
    expect(rejected).toStartWith('FAIL  @bun-native/core - HTTP 404')
    expect(rejected).toContain('Not found')
  })

  test('reads publish order and resolves each registry directory name', () => {
    const root = mkdtempSync(join(tmpdir(), 'npm-publishers-'))
    try {
      writeFileSync(join(root, 'publish-order.txt'), 'cli\ncore\n')
      for (const [short, name] of [
        ['cli', '@bun-native/cli'],
        ['core', '@bun-native/core'],
      ] as [string, string][]) {
        mkdirSync(join(root, short))
        writeFileSync(join(root, short, 'package.json'), JSON.stringify({ name }))
      }
      expect(registryPackages(root)).toEqual(['@bun-native/cli', '@bun-native/core'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('npm trusted publisher probe requests', () => {
  test('reports every package and never stops at the first rejection', async () => {
    const original = globalThis.fetch
    const requested: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      const name = url.split('/package/')[1] ?? ''
      const status = name === '@bun-native%2fcli' ? 200 : 404
      return new Response(status === 200 ? '{"token":"t"}' : '{"error":"no publisher"}', {
        status,
      })
    }) as typeof fetch
    try {
      const results = await probe(['@bun-native/cli', '@bun-native/core'], {
        registry: 'https://registry.npmjs.org/',
        token: 'oidc-token',
      })
      expect(results.map((result) => [result.name, result.status, result.accepted])).toEqual([
        ['@bun-native/cli', 200, true],
        ['@bun-native/core', 404, false],
      ])
      expect(
        requested.every((url) =>
          url.endsWith('/-/npm/v1/oidc/token/exchange/package/' + url.split('/package/')[1])
        )
      ).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})

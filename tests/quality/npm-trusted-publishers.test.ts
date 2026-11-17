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
  parseOptions,
  probe,
  registryPackages,
  run,
} from '../../scripts/quality/npm-trusted-publishers.ts'

/** A fetch double that answers the OIDC request, then the package exchanges. */
function fetchDouble(options: {
  statuses: Record<string, number>
  token?: () => Response
  exchangeBodies?: Record<string, string>
}): { fetchImpl: typeof fetch; requested: string[] } {
  const requested: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (!url.includes('/package/'))
      return (options.token ?? (() => Response.json({ value: 'oidc' })))()
    const escaped = url.split('/package/')[1] ?? ''
    const status = options.statuses[escaped] ?? 404
    const body =
      options.exchangeBodies?.[escaped] ??
      (status === 200 ? '{"token":"t"}' : '{"error":"no publisher"}')
    return new Response(body, { status })
  }) as typeof fetch
  return { fetchImpl, requested }
}

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/request',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  GITHUB_REPOSITORY: 'AndrewM-F/bun-native',
  GITHUB_WORKFLOW_REF: 'AndrewM-F/bun-native/.github/workflows/release.yml@refs/heads/main',
}

describe('npm trusted publisher probe', () => {
  // npm's client escapes with npm-package-arg's escapedName, which keeps the `@`
  // and lowercases the scope separator. encodeURIComponent sends
  // `%40scope%2Fname` instead, so the path must not be built that way.
  test('escapes a scoped package the way the npm client does', () => {
    expect(escapePackageName('@bun-native/cli')).toBe('@bun-native%2fcli')
    expect(escapePackageName('left-pad')).toBe('left-pad')
    expect(escapePackageName('@bun-native/cli')).not.toBe(encodeURIComponent('@bun-native/cli'))
    // A malformed name must not be able to add a path segment to the request.
    for (const bad of ['', 'a/b/c', '@scope/', '/name'])
      expect(() => escapePackageName(bad)).toThrow('not scope/name')
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

  test('keeps the registry status in the reported detail', () => {
    expect(formatResult(classify('@bun-native/cli', 200, ''))).toStartWith('OK    @bun-native/cli')
    const rejected = formatResult(classify('@bun-native/core', 404, '{"error":"Not found"}'))
    expect(rejected).toStartWith('FAIL  @bun-native/core - HTTP 404')
    expect(rejected).toContain('Not found')
    expect(formatResult(classify('@bun-native/core', 500, '')).length).toBeGreaterThan(0)
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

  test('accepts names or a registry directory, and rejects unusable arguments', () => {
    expect(parseOptions(['--names', 'a,b ,c'])).toEqual({
      registry: 'https://registry.npmjs.org/',
      names: ['a', 'b', 'c'],
    })
    expect(parseOptions(['--names', 'a', '--registry', 'https://r.example/']).registry).toBe(
      'https://r.example/'
    )
    expect(() => parseOptions([])).toThrow('Pass --names')
    expect(() => parseOptions(['--names'])).toThrow('needs a value')
    expect(() => parseOptions(['stray'])).toThrow('Unexpected argument')
  })
})

describe('npm trusted publisher probe requests', () => {
  test('reports every package and never stops at the first rejection', async () => {
    const { fetchImpl, requested } = fetchDouble({
      statuses: { '@bun-native%2fcli': 200, '@bun-native%2fcore': 404 },
    })
    const results = await probe({
      registry: 'https://registry.npmjs.org/',
      names: ['@bun-native/cli', '@bun-native/core'],
      token: 'oidc',
      fetchImpl,
    })
    expect(results.map((result) => [result.name, result.status, result.accepted])).toEqual([
      ['@bun-native/cli', 200, true],
      ['@bun-native/core', 404, false],
    ])
    expect(requested).toHaveLength(2)
  })

  test('succeeds when every package accepts this workflow', async () => {
    const { fetchImpl } = fetchDouble({
      statuses: { '@bun-native%2fcli': 200, '@bun-native%2fcore': 200 },
    })
    expect(await run(['--names', '@bun-native/cli,@bun-native/core'], env, fetchImpl)).toBe(0)
  })

  test('fails and names the identity to register when any package rejects it', async () => {
    const { fetchImpl } = fetchDouble({ statuses: { '@bun-native%2fcli': 200 } })
    expect(await run(['--names', '@bun-native/cli,@bun-native/core'], env, fetchImpl)).toBe(1)
  })

  test('fails without an OIDC request when the job cannot mint one', async () => {
    expect(await run(['--names', '@bun-native/cli'], {})).toBe(1)
    expect(
      await run(['--names', '@bun-native/cli'], { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' })
    ).toBe(1)
  })

  test('fails when GitHub rejects the OIDC request or omits the token value', async () => {
    for (const token of [() => new Response('nope', { status: 401 }), () => Response.json({})]) {
      const { fetchImpl } = fetchDouble({ statuses: {}, token })
      const original = globalThis.fetch
      globalThis.fetch = fetchImpl
      try {
        expect(await run(['--names', '@bun-native/cli'], env)).toBe(1)
      } finally {
        globalThis.fetch = original
      }
    }
  })
})

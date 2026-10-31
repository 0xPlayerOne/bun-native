import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { downloadPinnedArchive } from '../../scripts/install-bun/download.mjs'
import toolchain from '../../toolchain.json'

const payload = Buffer.from('pinned archive fixture')
const archive = { assetId: 123, sha256: createHash('sha256').update(payload).digest('hex') }
const temporary: string[] = []
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

function sequence(...responses: Response[]) {
  const requests: { url: string; options: RequestInit }[] = []
  const records: unknown[] = []
  return {
    requests,
    records,
    options: {
      report: (record: unknown) => records.push(record),
      fetchImplementation: async (url: URL, options: RequestInit) => {
        requests.push({ url: url.href, options })
        const response = responses.shift()
        if (!response) throw new Error('Unexpected additional request')
        return response
      },
    },
  }
}

test('immutable asset authentication stops before its signed storage redirect', async () => {
  const token = 'ghs_test_credential_never_log'
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true
      },
    }),
    {
      status: 302,
      headers: {
        location: 'https://release-assets.githubusercontent.com/file.zip?signature=private',
      },
    }
  )
  const http = sequence(response, new Response(payload))
  expect(await downloadPinnedArchive(archive, { ...http.options, token })).toEqual(payload)
  expect(cancelled).toBe(true)
  expect(http.requests).toHaveLength(2)
  const first = http.requests[0]!
  const second = http.requests[1]!
  expect(first.url).toBe('https://api.github.com/repos/oven-sh/bun/releases/assets/123')
  expect(new Headers(first.options.headers).get('authorization')).toBe(`Bearer ${token}`)
  expect(new Headers(first.options.headers).get('x-github-api-version')).toBe('2022-11-28')
  expect(new Headers(second.options.headers).has('authorization')).toBe(false)
  expect(second.options.signal).toBe(first.options.signal)
  expect(first.options.signal?.aborted).toBe(false)
  expect(first.options.redirect).toBe('manual')
  expect(second.options.redirect).toBe('manual')
  expect(JSON.stringify(http.records)).not.toContain(token)
  expect(JSON.stringify(http.records)).not.toContain('signature')
})

test('anonymous bootstrap still verifies the exact archive digest', async () => {
  const http = sequence(new Response(payload))
  // Exercise the production safe-metadata reporter, not a synthetic installer.
  expect(
    await downloadPinnedArchive(archive, { fetchImplementation: http.options.fetchImplementation })
  ).toEqual(payload)
  expect(new Headers(http.requests[0]!.options.headers).has('authorization')).toBe(false)
})

test.each([401, 403, 404])(
  'HTTP %s fails once without retry, fallback or response-body disclosure',
  async (status) => {
    const token = 'ghs_failure_fixture'
    const http = sequence(
      new Response(`private body ${token}`, {
        status,
        headers: {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1793440000',
          'x-ratelimit-used': '60',
          'x-github-request-id': 'ABCD:1234:5678',
          'retry-after': '12',
        },
      })
    )
    await expect(downloadPinnedArchive(archive, { ...http.options, token })).rejects.toThrow(
      `HTTP ${status}`
    )
    expect(http.requests).toHaveLength(1)
    expect(http.records).toEqual([
      {
        phase: 'asset-api',
        status,
        authenticated: true,
        rateLimit: { limit: 60, remaining: 0, used: 60, reset: 1793440000 },
        requestId: 'ABCD:1234:5678',
        retryAfterSeconds: 12,
      },
    ])
    expect(JSON.stringify(http.records)).not.toContain(token)
    expect(JSON.stringify(http.records)).not.toContain('private body')
  }
)

test.each([
  'http://release-assets.githubusercontent.com/file.zip',
  'https://release-assets.githubusercontent.com.attacker.invalid/file.zip',
  'https://user:password@release-assets.githubusercontent.com/file.zip',
  'https://objects.githubusercontent.com:8443/file.zip',
  'https://api.github.com/repos/oven-sh/bun/releases/latest',
  '/relative/location',
])('refuses an unapproved redirect before sending any credential: %s', async (location) => {
  const http = sequence(new Response(null, { status: 302, headers: { location } }))
  await expect(
    downloadPinnedArchive(archive, { ...http.options, token: 'ghs_test' })
  ).rejects.toThrow('redirect')
  expect(http.requests).toHaveLength(1)
})

test('approved redirects remain bounded and never regain authentication', async () => {
  const http = sequence(
    ...Array.from(
      { length: 6 },
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/repeated' },
        })
    )
  )
  await expect(
    downloadPinnedArchive(archive, { ...http.options, token: 'ghs_test' })
  ).rejects.toThrow('redirect limit')
  expect(http.requests).toHaveLength(6)
  expect(
    http.requests
      .slice(1)
      .every(({ options }) => !new Headers(options.headers).has('authorization'))
  ).toBe(true)
})

test('changed archive bytes never cross the checksum-before-extraction boundary', async () => {
  const http = sequence(new Response('changed archive bytes'))
  await expect(downloadPinnedArchive(archive, http.options)).rejects.toThrow('checksum mismatch')
  expect(http.requests).toHaveLength(1)
})

test('invalid pins and header-injection tokens fail before network activity', async () => {
  const http = sequence()
  await expect(downloadPinnedArchive({ ...archive, assetId: -1 }, http.options)).rejects.toThrow(
    'asset ID'
  )
  await expect(downloadPinnedArchive({ ...archive, sha256: 'bad' }, http.options)).rejects.toThrow(
    'checksum'
  )
  await expect(
    downloadPinnedArchive(archive, { ...http.options, token: 'ghs_bad\nInjected: value' })
  ).rejects.toThrow('without whitespace')
  expect(http.requests).toHaveLength(0)
})

test('network and body errors cannot disclose signed URLs or response-body secrets', async () => {
  const secret = 'private-signed-url-or-token'
  await expect(
    downloadPinnedArchive(archive, {
      fetchImplementation: async () => {
        throw new Error(secret)
      },
    })
  ).rejects.toThrow('Pinned Bun download request failed')
  const http = sequence(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(secret))
        },
      })
    )
  )
  await expect(downloadPinnedArchive(archive, http.options)).rejects.toThrow(
    'Pinned Bun download body failed'
  )
  expect(JSON.stringify(http.records)).not.toContain(secret)
})

test('a failed response body cancellation preserves the safe HTTP failure', async () => {
  const http = sequence(
    new Response(
      new ReadableStream({
        cancel() {
          throw new Error('private cancellation detail')
        },
      }),
      { status: 403 }
    )
  )
  await expect(downloadPinnedArchive(archive, http.options)).rejects.toThrow('HTTP 403')
})

test('redirect-body cancellation errors cannot leak details or restore authentication', async () => {
  const http = sequence(
    new Response(
      new ReadableStream({
        cancel() {
          throw new Error('private signed redirect detail')
        },
      }),
      {
        status: 302,
        headers: { location: 'https://objects.githubusercontent.com/file.zip' },
      }
    ),
    new Response(payload)
  )
  expect(await downloadPinnedArchive(archive, { ...http.options, token: 'ghs_test' })).toEqual(
    payload
  )
  expect(new Headers(http.requests[1]!.options.headers).has('authorization')).toBe(false)
  expect(JSON.stringify(http.records)).not.toContain('private signed redirect detail')
})

test('the installer strips its scoped credential before revision verification subprocesses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-installer-env-'))
  temporary.push(directory)
  const destination = join(directory, 'installed')
  const executable = join(destination, process.platform === 'win32' ? 'bun.exe' : 'bun')
  await Bun.write(
    executable,
    'This fixture intercepts subprocess creation; it is not an executable.'
  )
  const preload = join(directory, 'guard.mjs')
  await Bun.write(
    preload,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = (_command, _args, options) => {
  if (process.env.BUN_NATIVE_GITHUB_TOKEN || options.env?.BUN_NATIVE_GITHUB_TOKEN) throw new Error('Credential inherited by child');
  return { status: 0, stdout: ${JSON.stringify(toolchain.bun.cliRevision)}, stderr: '' };
};
globalThis.fetch = () => { throw new Error('Existing install must not download'); };
syncBuiltinESMExports();
`
  )
  const result = spawnSync(
    'node',
    [
      '--import',
      pathToFileURL(preload).href,
      resolve(import.meta.dir, '../../scripts/install-bun.mjs'),
      '--destination',
      destination,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, BUN_NATIVE_GITHUB_TOKEN: 'ghs_subprocess_fixture', GITHUB_PATH: '' },
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).not.toContain('ghs_subprocess_fixture')
  expect(JSON.parse(result.stdout).revision).toBe(toolchain.bun.cliRevision)
})

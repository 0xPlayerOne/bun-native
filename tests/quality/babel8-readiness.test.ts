import { expect, test } from 'bun:test'
import { check, evaluate, summary } from '../../scripts/quality/babel8-readiness.ts'

const packument = (peer: Record<string, string>) => ({
  'dist-tags': { latest: '1.9.19', next: '2.0.0-rc.2' },
  versions: {
    '1.9.19': { peerDependencies: { '@babel/core': '^7.0.0' } },
    '2.0.0-rc.2': { peerDependencies: peer },
  },
})

test('a Babel 7 peer range is reported as not ready', () => {
  const reports = evaluate(packument({ '@babel/core': '^7.0.0' }))
  expect(reports.map((r) => [r.tag, r.supportsBabel8])).toEqual([
    ['latest', false],
    ['next', false],
  ])
  expect(summary(reports)).toContain('No tagged release declares Babel 8 support')
})

test('a peer range admitting Babel 8 is reported as ready', () => {
  const reports = evaluate(packument({ '@babel/core': '^7.0.0 || ^8.0.0' }))
  expect(reports.find((r) => r.tag === 'next')?.supportsBabel8).toBe(true)
  expect(summary(reports)).toContain('Start the #316 qualification')
})

test('a release without a Babel peer is not treated as ready', () => {
  const reports = evaluate(packument({}))
  expect(reports.find((r) => r.tag === 'next')).toMatchObject({
    babelPeer: null,
    supportsBabel8: false,
  })
})

test('an unexpected registry document fails instead of reporting not ready', () => {
  expect(() => evaluate({})).toThrow('no dist-tags')
  expect(() => evaluate({ 'dist-tags': { latest: '9.9.9' }, versions: {} })).toThrow(
    'missing version 9.9.9'
  )
})

test('check reads the registry document and emits a notice per ready tag', async () => {
  const urls: string[] = []
  const result = await check('https://registry.example/', async (url) => {
    urls.push(url)
    return Response.json(packument({ '@babel/core': '^8.0.0' }))
  })
  expect(urls).toEqual(['https://registry.example/babel-preset-solid'])
  expect(result.notices).toHaveLength(1)
  expect(result.notices[0]).toContain('babel-preset-solid@2.0.0-rc.2 (next)')
  await expect(
    check('https://registry.example', async () => new Response('', { status: 503 }))
  ).rejects.toThrow('registry returned 503')
})

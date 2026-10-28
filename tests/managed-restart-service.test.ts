import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevelopmentSession } from '../packages/cli/src/dev-host.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import { ServiceReloadHost } from '../packages/runtime/src/service-reload.ts'

test('restart service reads the actual edited graph and configuration in a fresh Worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-restart-service-'))
  const previousRoot = process.env['BUNLY_MANAGED_ROOT']
  process.env['BUNLY_MANAGED_ROOT'] = root
  const configuration = '{"changedNativeConfiguration":true}\n'
  const owner = new ManagedGenerationOwner()
  // Resource operations are a unit-test boundary only; native CEF proof is the separate launch.
  const view = owner.register({
    kind: 'view',
    schema: 'view:1',
    permission: 'fixture',
    authorize: () => true,
    invoke: () => JSON.stringify({ documentId: 'fixture-document', url: 'app://ui/restart.html' }),
    dispose() {},
  })
  const session = owner.register({
    kind: 'session',
    schema: 'session:1',
    permission: 'fixture',
    authorize: () => true,
    invoke: (operation) => (operation === 'cookies' ? '[]' : '{"id":"fixture-session"}'),
    dispose() {},
  })
  const broker = new ServiceReloadHost({
    owner,
    stateSchema: 'managed-restart:1',
    permissions: ['fixture'],
    resources: {
      view: { resource: view, schema: 'view:1' },
      session: { resource: session, schema: 'session:1' },
    },
  })
  let development: DevelopmentSession | undefined
  try {
    for (const directory of ['backend', 'shared', 'frontend'])
      await cp(
        new URL(`../examples/managed-desktop/${directory}`, import.meta.url),
        join(root, directory),
        { recursive: true }
      )
    await writeFile(join(root, 'backend/dependency.ts'), 'export const revision = 500\n')
    await writeFile(join(root, 'shared/value.ts'), 'export const shared = 1\n')
    await writeFile(join(root, 'bunly-dev.json'), configuration)
    let entry: string | undefined
    development = await DevelopmentSession.start({
      projectRoot: root,
      entrypoint: 'backend/restart-service.ts',
      backendRoots: ['backend'],
      sharedRoots: ['shared'],
      cacheRoot: '.cache',
      configurationFile: 'bunly-dev.json',
      watch: false,
      debounceMs: 0,
      reload: (bundle) => {
        entry = bundle.entry
        return broker.reload({ entry })
      },
      shutdown: () => broker.close(),
    })
    const result = JSON.parse(await broker.request('readback', 'null'))
    expect(result).toEqual({
      revision: 500,
      shared: 1,
      configurationApplied: true,
      configurationSha256: createHash('sha256').update(configuration).digest('hex'),
      loginAbsent: true,
      document: 'fixture-document',
      url: 'app://ui/restart.html',
      session: 'fixture-session',
    })
    expect(await readFile(join(root, 'bunly-dev.json'), 'utf8')).toBe(configuration)
    expect(broker.diagnostics()).toMatchObject({
      generations: 1,
      forcedTerminations: 0,
      mechanism: 'worker',
    })
    // A newly initialized Worker must inspect the real file, not echo an earlier configured flag.
    await writeFile(join(root, 'bunly-dev.json'), '{"changedNativeConfiguration":false}\n')
    await expect(broker.reload({ entry: entry! })).rejects.toThrow('PREPARE_FAILED')
    expect(JSON.parse(await broker.request('readback', 'null')).configurationApplied).toBe(true)
    await development.close()
    expect(broker.diagnostics()).toMatchObject({
      closed: true,
      generations: 0,
      requests: 0,
      hostCalls: 0,
      forcedTerminations: 0,
    })
  } finally {
    await development?.close()
    await broker.close()
    owner.dispose()
    if (previousRoot === undefined) delete process.env['BUNLY_MANAGED_ROOT']
    else process.env['BUNLY_MANAGED_ROOT'] = previousRoot
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

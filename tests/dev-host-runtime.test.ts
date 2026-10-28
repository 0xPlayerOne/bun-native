import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevelopmentSession } from '../packages/cli/src/dev-host.ts'
import { ManagedGenerationOwner } from '../packages/runtime/src/managed-generations.ts'
import {
  ServiceReloadHost,
  type ServiceReloadDiagnostic,
} from '../packages/runtime/src/service-reload.ts'

test.each(['worker', 'process'] as const)(
  'dev bundles integrate with the %s generation broker and preserve stable owner state',
  async (mechanism) => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-dev-runtime-'))
    const owner = new ManagedGenerationOwner()
    let total = 0,
      disposed = 0
    const resource = owner.register({
      kind: 'window',
      schema: 'counter:1',
      permission: 'counter',
      authorize: () => true,
      invoke: (_operation, input) => JSON.stringify((total += Number(JSON.parse(input)))),
      dispose: () => {
        disposed++
      },
    })
    const diagnostics: ServiceReloadDiagnostic[] = []
    const broker = new ServiceReloadHost({
      owner,
      stateSchema: 'app:1',
      permissions: ['counter'],
      mechanism,
      resources: { counter: { resource, schema: 'counter:1' } },
      readyTimeoutMs: 1000,
      retireTimeoutMs: 1000,
      exitTimeoutMs: 2000,
      onDiagnostic: (event) => {
        diagnostics.push(event)
      },
    })
    let session: DevelopmentSession | undefined
    try {
      await mkdir(join(root, 'backend'))
      await writeFile(join(root, 'backend/value.ts'), 'export const value = 1')
      await writeFile(
        join(root, 'backend/main.ts'),
        [
          "import {value} from './value.ts'",
          "export default context => ({schema:'app:1', handlers:{",
          'value: () => JSON.stringify(value),',
          "add: input => context.invoke('counter','add',input)",
          '}})',
        ].join('\n')
      )
      session = await DevelopmentSession.start({
        projectRoot: root,
        entrypoint: 'backend/main.ts',
        backendRoots: ['backend'],
        cacheRoot: '.bunly/dev',
        watch: false,
        debounceMs: 0,
        reload: ({ entry }) => broker.reload({ entry }),
        shutdown: () => broker.close(),
      })
      expect(await broker.request('value', 'null')).toBe('1')
      expect(await broker.request('add', '7')).toBe('7')
      await writeFile(join(root, 'backend/value.ts'), 'export const value = 2')
      expect((await session.invalidate(['backend/value.ts'])).action).toBe('reloaded')
      expect(await broker.request('value', 'null')).toBe('2')
      expect(await broker.request('add', '5')).toBe('12')
      expect(disposed).toBe(0)
      expect(owner.diagnostics()).toMatchObject({
        active: 1,
        resources: 1,
        generations: 1,
        candidate: 0,
      })
      await writeFile(
        join(root, 'backend/value.ts'),
        'throw new Error("private-initialization-fixture");\nexport const value = 3'
      )
      expect((await session.invalidate(['backend/value.ts'])).action).toBe('failed')
      expect(await broker.request('value', 'null')).toBe('2')
      expect(session.diagnostics().restartRequired).toBe(false)
      expect(diagnostics.some((event) => event.detail?.includes('value.ts'))).toBe(true)
      await writeFile(join(root, 'backend/value.ts'), 'export const value = 4')
      expect((await session.invalidate(['backend/value.ts'])).action).toBe('reloaded')
      expect(await broker.request('value', 'null')).toBe('4')
      const dirs = await readdir(session.instanceDirectory)
      expect(dirs.filter((path) => path.startsWith('generation-'))).toHaveLength(1)
      const source = await readFile(
        join(session.instanceDirectory, dirs[0]!, 'application.js'),
        'utf8'
      )
      expect(source).toContain('sourceMappingURL=')
      await session.close()
      expect(broker.diagnostics().generations).toBe(0)
      expect(owner.diagnostics().resources).toBe(1)
      await owner.disposeResource(resource)
      expect(disposed).toBe(1)
    } finally {
      await session?.close()
      await broker.close()
      owner.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  15000
)

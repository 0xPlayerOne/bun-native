import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import type { CefBackend } from '../../../packages/runtime/src/cef.ts'
import { ManagedGenerationOwner } from '../../../packages/runtime/src/managed-generations.ts'
import { ServiceReloadHost } from '../../../packages/runtime/src/service-reload.ts'
import { DevelopmentSession } from '../../../packages/cli/src/dev-host.ts'
import { comparisonCommands, comparisonConfiguration, comparisonRegister } from './host.ts'

export default async function comparisonApplication(backend: CefBackend): Promise<void> {
  const config = comparisonConfiguration()
  const root = process.env['BUNLY_COMPARISON_PROJECT'] ?? ''
  const runner = process.env['BUNLY_SERVICE_RUNNER'] ?? ''
  assert.ok(isAbsolute(root) && isAbsolute(runner))
  const owner = new ManagedGenerationOwner()
  const broker = new ServiceReloadHost({
    owner,
    runner,
    stateSchema: 'comparison:1',
    permissions: [],
    initialState: '{}',
    mechanism: 'worker',
  })
  let development: DevelopmentSession | undefined
  try {
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'managed-comparison',
      network: { allowedOrigins: [config.origin] },
    })
    const window = await backend.createWindow({
      title: 'Managed edit comparison',
      bounds: { x: 24, y: 24, width: 1000, height: 680 },
    })
    const view = await backend.createView({
      window,
      session,
      url: config.origin + '/#token=' + config.rendererToken,
      trust: { kind: 'remote' },
    })
    const identities = { window: window.id, view: view.id, session: session.id }
    development = await DevelopmentSession.start({
      projectRoot: root,
      entrypoint: 'src/service.ts',
      backendRoots: ['src'],
      cacheRoot: join(root, 'generations'),
      watch: false,
      reload: ({ entry }) => broker.reload({ entry }),
      shutdown: () => broker.close(),
    })
    const register = async (revision: number) => {
      const actual = JSON.parse(await broker.request('revision', 'null')) as number
      assert.equal(actual, revision)
      assert.ok(backend.state(view).url.startsWith(config.origin + '/'))
      await comparisonRegister(config, {
        revision: actual,
        framework: 'bunly',
        version: '0.1.0-dev.0',
        identities,
      })
    }
    await register(0)
    await comparisonCommands(config, async (revision) => {
      assert.equal(
        (await development!.invalidate([join(root, 'src/revision.ts')])).backendReplaced,
        true
      )
      await register(revision)
    })
    await development.close()
    await owner.dispose()
    // Keep the last native window until the final quit, so cleanup RPC remains live.
    await backend.disposeView(view)
    await backend.disposeSession(session)
    await backend.dispose()
  } finally {
    await development?.close()
    await broker.close()
    await owner.dispose()
    await backend.dispose()
  }
}

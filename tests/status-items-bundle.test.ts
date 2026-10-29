import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'bun:test'
import { BunlyError } from '../packages/contracts/src/index.ts'

test('separately bundled status fixture recognizes actual SDK denial without sharing its error class', async () => {
  const output = await mkdtemp(join(tmpdir(), 'bunly-status-bundle-'))
  const root = resolve(import.meta.dir, '..')
  let close = async () => {}
  try {
    const entry = join(output, 'host.ts')
    await writeFile(
      entry,
      [
        `export { CefBackend } from ${JSON.stringify(join(root, 'packages/runtime/src/cef.ts'))}`,
        `export { BunlyError } from ${JSON.stringify(join(root, 'packages/contracts/src/index.ts'))}`,
        `export { nativePeer } from ${JSON.stringify(join(root, 'tests/helpers/native-peer.ts'))}`,
      ].join('\n')
    )
    // Bootstrap and application are independent builds in the real qualifier.
    for (const [input, filename] of [
      [entry, 'main.js'],
      [join(root, 'examples/status-items/fixture.ts'), 'application.js'],
    ] as const) {
      const built = await Bun.build({
        entrypoints: [input],
        outdir: output,
        naming: filename,
        target: 'bun',
        format: 'esm',
        sourcemap: 'linked',
        minify: false,
      })
      assert.equal(built.success, true)
    }
    const host = (await import(pathToFileURL(join(output, 'main.js')).href)) as {
      CefBackend: typeof import('../packages/runtime/src/cef.ts').CefBackend
      BunlyError: typeof BunlyError
      nativePeer: typeof import('./helpers/native-peer.ts').nativePeer
    }
    const application = (await import(
      pathToFileURL(join(output, 'application.js')).href
    )) as typeof import('../examples/status-items/fixture.ts')
    assert.notEqual(host.BunlyError, BunlyError)
    const peer = await host.nativePeer({
      desktopCapabilities: { version: 1, capabilities: ['status.item', 'app.lifecycle'] },
    })
    let next = 0,
      denials = 0
    peer.handle((command) => {
      if (command.op === 'status.create') {
        denials++
        peer.reject(command, 'PERMISSION_DENIED: Status item grant missing')
      } else if (command.op === 'policy.scope')
        peer.reply(command, {
          view: 3,
          session: 1,
          generation: 1,
          mainFrame: 'main',
          document: 'native-3-1',
          origin: 'app://ui',
        })
      else peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
      if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
    })
    const backend = new host.CefBackend(peer.transport)
    close = () => backend.dispose()
    const session = await backend.createSession({ persistence: 'ephemeral', partition: 'status' })
    const window = await backend.createWindow({
      title: 'Status bundle boundary',
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    })
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const scope = await backend.capturePolicyScope(view)
    await assert.rejects(backend.createStatusItem(scope, { title: 'Denied' }), (error: unknown) => {
      assert.ok(error instanceof host.BunlyError)
      assert.equal(error instanceof BunlyError, false)
      assert.equal(error.code, 'PERMISSION_DENIED')
      return application.hasCode('PERMISSION_DENIED')(error)
    })
    assert.equal(denials, 1)
    assert.equal(
      application.hasCode('UNSUPPORTED_CAPABILITY')(
        new host.BunlyError('UNSUPPORTED_CAPABILITY', 'Unavailable fixture capability')
      ),
      true
    )
    for (const value of [
      new host.BunlyError('INVALID_ARGUMENT', 'Different code'),
      Object.assign(new Error('Unrelated error'), { code: 'PERMISSION_DENIED' }),
      { name: 'BunlyError', code: 'PERMISSION_DENIED' },
      new Error('PERMISSION_DENIED'),
      'PERMISSION_DENIED',
      null,
    ])
      assert.equal(application.hasCode('PERMISSION_DENIED')(value), false)
  } finally {
    try {
      await close()
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }
}, 15_000)

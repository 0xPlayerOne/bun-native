import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'bun:test'
import { BunlyError } from '../packages/contracts/src/index.ts'

test('separately bundled dialog fixture recognizes actual SDK permission denials', async () => {
  const output = await mkdtemp(join(tmpdir(), 'bunly-dialog-bundle-'))
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
    // The qualifier bundles bootstrap and application independently. Keep that
    // boundary here: one build with two entrypoints could share class identity.
    for (const [input, filename] of [
      [entry, 'main.js'],
      [join(root, 'examples/file-dialogs/fixture.ts'), 'application.js'],
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
    )) as typeof import('../examples/file-dialogs/fixture.ts')
    assert.notEqual(host.BunlyError, BunlyError)
    const peer = await host.nativePeer()
    let next = 0,
      denials = 0
    peer.handle((command) => {
      if (command.op === 'dialog.show') {
        denials++
        peer.reject(command, 'PERMISSION_DENIED: file dialog grant missing')
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
    const session = await backend.createSession({ persistence: 'ephemeral', partition: 'dialogs' })
    const window = await backend.createWindow({
      title: 'Dialog bundle boundary',
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    })
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const scope = await backend.capturePolicyScope(view)
    for (const kind of ['open', 'save'] as const) {
      const denied =
        kind === 'open'
          ? backend.showOpenFileDialog(scope, { directory: '/owned-fixture' })
          : backend.showSaveFileDialog(scope, {
              directory: '/owned-fixture',
              suggestedName: 'unused.txt',
            })
      await assert.rejects(denied, (error: unknown) => {
        assert.ok(error instanceof host.BunlyError)
        assert.equal(error instanceof BunlyError, false)
        assert.equal(error.code, 'PERMISSION_DENIED')
        return application.hasCode('PERMISSION_DENIED')(error)
      })
    }
    assert.equal(denials, 2)
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

/** Replace every JavaScript backend layer in a private prepared-app clone.
 * Reusing main.js would execute the input artifact's CefBackend even when the
 * application bundle and source fingerprints describe a newer implementation. */
import assert from 'node:assert/strict'
import { LOAD_DEFINES } from '../examples/cef-terminal-load/profile.ts'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
export async function buildTerminalBackend(root: string, resources: string, load: boolean) {
  const entries = [
    ['scripts/cef-bootstrap.ts', 'main.js'],
    [
      load ? 'examples/cef-terminal-load/fixture.ts' : 'examples/cef-terminal/terminal-fixture.ts',
      'application.js',
    ],
    [
      load ? 'examples/cef-terminal-load/child.ts' : 'examples/cef-terminal/terminal-child.ts',
      'terminal-child.js',
    ],
  ] as const
  const result: Record<string, { source: string; bytes: number; sha256: string }> = {}
  for (const [source, name] of entries) {
    const built = await Bun.build({
      entrypoints: [join(root, source)],
      outdir: join(resources, 'backend'),
      naming: name,
      target: 'bun',
      format: 'esm',
      minify: false,
      ...(load ? { define: LOAD_DEFINES } : {}),
    })
    assert.ok(built.success, built.logs.join('\n'))
    const bytes = await readFile(join(resources, 'backend', name))
    result[name] = {
      source,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  return result
}

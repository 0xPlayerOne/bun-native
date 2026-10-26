import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildTerminalBackend } from '../scripts/build-terminal-backend.ts'
const root = resolve(import.meta.dir, '..')
test('prepared terminal clone replaces stale bootstrap with exact current CefBackend and scheduler', async () => {
  const work = await mkdtemp(join(tmpdir(), 'bunly-terminal-bootstrap-'))
  try {
    await mkdir(join(work, 'backend'))
    await writeFile(join(work, 'backend/main.js'), 'throw new Error("stale input runtime")\n')
    const result = await buildTerminalBackend(root, work, true)
    const expected = await Bun.build({
      entrypoints: [join(root, 'scripts/cef-bootstrap.ts')],
      target: 'bun',
      format: 'esm',
      minify: false,
    })
    assert.ok(expected.success)
    const actual = await readFile(join(work, 'backend/main.js'), 'utf8')
    assert.equal(
      createHash('sha256').update(actual).digest('hex'),
      createHash('sha256')
        .update(await expected.outputs[0]!.text())
        .digest('hex'),
      'Stale bootstrap survived preparation'
    )
    assert.match(actual, /class FairWorkScheduler|FairWorkScheduler = class/)
    assert.match(actual, /class CefLaneTransport|CefLaneTransport = class/)
    assert.deepEqual(Object.keys(result).sort(), ['application.js', 'main.js', 'terminal-child.js'])
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}, 15000)

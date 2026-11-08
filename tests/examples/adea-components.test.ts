import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSolid } from '../../scripts/solid-build.ts'
import { oklchToRgb, tint } from '../../examples/adea-components/tokens.ts'

const EXAMPLE = resolve(import.meta.dir, '../../examples/adea-components')

test('Adea components mount, stream without remounting rows, theme, open and dismiss the menu and dialog, and dispose', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-adea-components-'))
  try {
    const application = await buildSolid(
      resolve(import.meta.dir, 'adea-components-contract.tsx'),
      directory
    )
    const child = Bun.spawn([process.execPath, application], {
      env: {
        ...process.env,
        BUN_NATIVE_EXAMPLE_TEST_PEER: resolve(import.meta.dir, '../core/overlay-peer.ts'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, signal: child.signalCode, stderr }).toEqual({
      exit: 0,
      signal: null,
      stderr: '',
    })
    const report = JSON.parse(stdout)
    const lines = (tree: string[]) => tree.map((line) => line.trim())
    expect(lines(report.initial)).toContain('button:Conversation')
    expect(lines(report.initial).filter((line) => line.startsWith('button:'))).toEqual([
      'button:Conversation',
      'button:Dark theme',
      'button:default',
      'button:secondary',
      'button:outline',
      'button:ghost',
      'button:subtle',
      'button:success',
      'button:destructive',
      'button:link',
      'button:Send',
    ])
    expect(report.mounted).toEqual({ created: 2, disposed: 0, timers: 0, ownerDisposed: false })
    // Eight versions of the streamed reply update one row: Adea's retained
    // keyedRows/sameShownMessage policy keeps every row's identity.
    expect(report.streamed.stats).toEqual({
      created: 4,
      disposed: 0,
      timers: 0,
      ownerDisposed: false,
    })
    expect(lines(report.streamed.tree)).toContain(
      'text:Native rows keep their identity while streaming.'
    )
    expect(lines(report.streamed.tree)).toContain('text:native edit')
    expect(report.themed).toEqual({ stats: report.streamed.stats, lightButton: true })
    expect(report.menuOpen).toEqual({
      overlay: true,
      items: ['button:Rename', 'button:Export', 'button:Delete'],
    })
    expect(report.menuEscaped).toBe(false)
    expect(report.menuExport).toEqual({ overlay: false, status: true })
    expect(report.dialogOpen).toEqual({ overlay: true, title: true })
    expect(report.backdropDismissed).toBe(false)
    expect(report.closeDismissed).toBe(false)
    expect(report.deleted).toEqual({
      stats: { created: 4, disposed: 4, timers: 0, ownerDisposed: false },
      overlay: false,
      status: true,
    })
    expect(report.evidence).toEqual([
      'sent',
      'reply-complete',
      'theme',
      'menu',
      'menu',
      'dialog-dismissed',
      'menu',
      'dialog-dismissed',
      'menu',
      'deleted',
    ])
    expect(report.closed).toEqual({
      nodes: 0,
      listeners: 0,
      stats: { created: 4, disposed: 4, timers: 0, ownerDisposed: true },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test('Adea OKLCH tokens convert to the sRGB values a browser computes', () => {
  expect(oklchToRgb('oklch(1 0 0)')).toBe(0xffffff)
  expect(oklchToRgb('oklch(0 0 0)')).toBe(0x000000)
  // Chromium 1x1 canvas readbacks of Adea light --primary, dark --background,
  // dark --primary and dark --success (playwright chromium, sRGB canvas).
  expect(oklchToRgb('oklch(0.5143 0.1668 301.69)').toString(16)).toBe('7a49b5')
  expect(oklchToRgb('oklch(0.1756 0.0063 300.91)').toString(16)).toBe('111013')
  expect(oklchToRgb('oklch(0.7323 0.1668 301.69)').toString(16)).toBe('bc8cff')
  expect(oklchToRgb('oklch(0.6951 0.1809 145.62)').toString(16)).toBe('3fb950')
  expect(() => oklchToRgb('#fff')).toThrow('Unsupported color')
  expect(tint(0xffffff, 0.5, 0x000000)).toBe(0x808080)
})

test('retained Adea sources match their recorded upstream blobs', () => {
  // git blob ids at adea 37dd7406 (packages/workspace-ui/src); see the README inventory.
  const blob = (path: string) => {
    const bytes = readFileSync(join(EXAMPLE, path))
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  }
  expect(blob('retained/keyed-rows.ts')).toBe('0f30eab627e7ca87aa6932946939878b464fc8a8')
  const transcript = readFileSync(join(EXAMPLE, 'retained/transcript-history.ts'), 'utf8')
  // Two modified lines: the type import and an exactOptionalPropertyTypes-safe field.
  const upstream = transcript
    .replace(
      "import type { OpenedMessage } from '../types.ts'",
      "import type { OpenedMessage } from '@adea-ai/types'"
    )
    .replace('  olderBefore?: number | undefined', '  olderBefore?: number')
  expect(
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(upstream)}\0`)
      .update(upstream)
      .digest('hex')
  ).toBe('9c36ed88540236b02ff68e6ab9ca4e463671282d')
})

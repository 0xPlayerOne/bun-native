import { test, expect } from 'bun:test'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dir, '..')
async function profile(selected: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `globalThis.__bunlyTerminalLoadProfile=${JSON.stringify(selected)};
    const {LOAD,BATCHES}=await import('./examples/cef-terminal-load/workload.ts');
    const p=await import('./examples/cef-terminal-load/profile.ts');
    console.log(JSON.stringify({LOAD,BATCHES,observer:p.LOAD_OBSERVER_MS,bytes:p.LOAD_RAW_LIMIT,define:p.LOAD_DEFINES}));`,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  )
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, out, err }
}
test('soak changes only the fixed sustained horizon and explicit outer/record bounds', async () => {
  const standard = await profile('standard'),
    soak = await profile('soak')
  expect(standard.exit).toBe(0)
  expect(soak.exit).toBe(0)
  const a = JSON.parse(standard.out),
    b = JSON.parse(soak.out)
  expect(a.BATCHES).toBe(700)
  expect(b.BATCHES).toBe(2500)
  expect(a.observer).toBe(90000)
  expect(b.observer).toBe(180000)
  expect(a.bytes).toBe(4 * 1024 * 1024)
  expect(b.bytes).toBe(16 * 1024 * 1024)
  expect(b.LOAD).toEqual({
    ...a.LOAD,
    id: 'graphical-pty-soak-v2',
    phases: a.LOAD.phases.map((p: { name: string }) =>
      p.name === 'sustained' ? { ...p, batches: 2400 } : p
    ),
  })
  expect(b.BATCHES * (b.LOAD.recordsPerBatch + 1) + 1).toBeLessThanOrEqual(100000)
  expect(b.define).toEqual({ 'globalThis.__bunlyTerminalLoadProfile': '"soak"' })
  const rejected = await profile('arbitrary')
  expect(rejected.exit).not.toBe(0)
  expect(rejected.err).toContain('Unknown fixed terminal load profile')
})
test('browser and Bun compilation use the same explicit soak selector without host globals in browser contracts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunly-soak-define-'))
  try {
    const entry = join(dir, 'probe.ts')
    await Bun.write(
      entry,
      `import {LOAD,BATCHES} from ${JSON.stringify(join(root, 'examples/cef-terminal-load/workload.ts'))};console.log(JSON.stringify({LOAD,BATCHES}))`
    )
    for (const target of ['browser', 'bun'] as const) {
      const result = await Bun.build({
        entrypoints: [entry],
        target,
        format: 'esm',
        outdir: join(dir, target),
        define: { 'globalThis.__bunlyTerminalLoadProfile': '"soak"' },
      })
      expect(result.success).toBe(true)
      const child = Bun.spawn([process.execPath, result.outputs[0]!.path], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [exit, out] = await Promise.all([child.exited, new Response(child.stdout).text()])
      expect(exit).toBe(0)
      expect(JSON.parse(out).BATCHES).toBe(2500)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('windowed profile changes mode evidence, not per-terminal output or pacing', async () => {
  const standard = JSON.parse((await profile('standard')).out)
  const windowed = await profile('windowed')
  expect(windowed.exit).toBe(0)
  const current = JSON.parse(windowed.out)
  expect(current.LOAD).toEqual({
    ...standard.LOAD,
    id: 'graphical-pty-window-load-v3',
    modes: ['foreground', 'background', 'hidden', 'minimized'],
  })
  expect(current.BATCHES).toBe(700)
  expect(current.observer).toBe(90000)
  expect(current.define).toEqual({ 'globalThis.__bunlyTerminalLoadProfile': '"windowed"' })
})

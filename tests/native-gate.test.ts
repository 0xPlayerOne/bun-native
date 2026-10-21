import { test, expect } from 'bun:test'
import {
  nativeCommands,
  nativeManifests,
  nativeHookInvocation,
} from '../scripts/native-pre-commit.ts'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
test('native gate checks both real workspaces without a fake root manifest', () => {
  const files = [
    'native/host-probe/src/lib.rs',
    'native/cef-host/src/host.rs',
    'native/cef-host/Cargo.lock',
    'native/cef-host/src/bundle.rs',
  ]
  expect(nativeManifests(files)).toEqual(['native/Cargo.toml', 'native/cef-host/Cargo.toml'])
  const checks = nativeCommands(files, '/repo')
  expect(checks.length).toBe(4)
  expect(
    checks
      .filter((c) => c.command.includes('clippy'))
      .every((c) => c.command.includes('--locked') && c.command.includes('warnings'))
  ).toBe(true)
  expect(
    checks
      .filter((c) => c.command.includes('native/cef-host/Cargo.toml'))
      .find((c) => c.command.includes('clippy'))!.command
  ).toContain('packaging')
})
test('unknown Rust sources fail instead of silently skipping lint', () => {
  expect(() => nativeManifests(['unowned/src/main.rs'])).toThrow('no declared workspace')
  expect(nativeManifests(['scripts/tool.ts', 'docs/architecture.md'])).toEqual([])
})
test('hook and Foundry sync retain machine guards and native routing', async () => {
  const root = resolve(import.meta.dir, '..'),
    hook = await readFile(resolve(root, '.githooks/pre-commit'), 'utf8'),
    sync = await readFile(resolve(root, 'scripts/sync-foundry.ts'), 'utf8')
  expect(hook).toContain(nativeHookInvocation)
  expect(hook).toContain('CODE_FOUNDRY_HOOK_CHAIN=1')
  expect(sync).toContain('nativeHookInvocation')
})

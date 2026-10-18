import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STAGES, unsupportedStage } from '../benchmarks/lib/stages.ts';
import { BYTE_CATEGORIES, unavailableBytes } from '../benchmarks/lib/accounting.ts';
const root = resolve(import.meta.dir, '..');
test('ledger CLI exits incomplete when signing or byte measurements are unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-ledger-cli-'));
  try {
    const file = join(directory, 'ledger.json');
    await writeFile(file, JSON.stringify({ schema: 1, stages: STAGES.map(stage => unsupportedStage(stage, 'Fixture capability unavailable')), bytes: BYTE_CATEGORIES.map(category => unavailableBytes(category, 'Not measured')) }));
    const result = Bun.spawnSync([process.execPath, join(root, 'scripts/benchmark-ledger.ts'), file], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    expect(result.exitCode).toBe(2); const output = JSON.parse(result.stdout.toString());
    expect(output.status).toBe('incomplete'); expect(output.unmeasured).toHaveLength(14);
    expect(output.bytes.every((row: { bytes: unknown }) => row.bytes === null)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('CLI independently verifies pinned historical reports and rejects cross-platform comparison', () => {
  const result = Bun.spawnSync([process.execPath, join(root, 'scripts/verify-m2-baselines.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const value = JSON.parse(result.stdout.toString()); expect(value.verifiedReports).toBe(2); expect(value.comparison.comparable).toBe(false);
});
test('frontend qualifier fails clearly without a declared browser rather than choosing another one', () => {
  const env = { ...process.env }; delete env['BUNLY_BENCH_CHROMIUM'];
  const result = Bun.spawnSync([process.execPath, join(root, 'scripts/qualify-frontend.ts')], { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
  expect(result.exitCode).not.toBe(0); expect(result.stderr.toString()).toContain('BUNLY_BENCH_CHROMIUM');
});

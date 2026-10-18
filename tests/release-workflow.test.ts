import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGES } from '../benchmarks/lib/stages.ts';
import { runReleaseWorkflow, validateReleasePlan, verifyReceipt, type ReleasePlan, type ReleaseTask } from '../benchmarks/lib/release-workflow.ts';
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts';
const task = (): ReleaseTask => ({ dependsOn: [], commands: [[process.execPath, 'run.mjs']], verify: [process.execPath, 'verify.mjs'], outputs: [], timeoutMs: 15000 });
function plan(): ReleasePlan {
  return { schema: 1, framework: 'explicit-test-fixture', version: '1', sourceCommit: 'a'.repeat(40), tasks: { 'app-assembly': task() },
    unsupported: Object.fromEntries(STAGES.filter(s => s !== 'app-assembly').map(s => [s, 'Not part of this test plan'])) };
}
test('release plans retain every stage and reject duplicate dispositions and cycles', () => {
  expect(validateReleasePlan(plan()).schema).toBe(1);
  const v = structuredClone(plan()) as any;
  delete v.unsupported.update; expect(() => validateReleasePlan(v)).toThrow();
  v.unsupported.update = 'none'; v.unsupported['app-assembly'] = 'none'; expect(() => validateReleasePlan(v)).toThrow();
  delete v.unsupported['app-assembly']; delete v.unsupported.update;
  v.tasks.update = { ...task(), dependsOn: ['app-assembly'] }; v.tasks['app-assembly'].dependsOn = ['update'];
  expect(() => validateReleasePlan(v)).toThrow();
});
for (const path of ['../escape', '/etc/file', 'C:/file', 'a/../b', 'a\\b', 'a//b', '']) test('reject unsafe output path ' + JSON.stringify(path), () => {
  const v = structuredClone(plan()) as any; v.tasks['app-assembly'].outputs = [{ category: 'installed', kind: 'file', path, fresh: true }];
  expect(() => validateReleasePlan(v)).toThrow();
});
test('reject false download accounting and unknown command shapes', () => {
  const v = structuredClone(plan()) as any;
  v.tasks['app-assembly'].outputs = [{ category: 'first-run-download', kind: 'file', path: 'artifact', fresh: true }];
  expect(() => validateReleasePlan(v)).toThrow();
  v.tasks['app-assembly'].outputs = []; v.tasks['app-assembly'].commands = ['echo hi']; expect(() => validateReleasePlan(v)).toThrow();
  v.tasks['app-assembly'].commands = [[process.execPath]]; v.tasks['app-assembly'].verify = []; expect(() => validateReleasePlan(v)).toThrow();
});
const receipt = (nonce: string, stage = 'app-assembly') => JSON.stringify({ event: 'benchmark-verification', nonce, stage, passed: true, evidence: 'Read and verified actual output' });
function observation(lines: string[]): CommandObservation { return { exitCode: 0, timedOut: false, cancelled: false, cleanupSurvivors: [], outputOverflow: false, observedOrphans: [], elapsedMs: 1, peakTreeRssBytes: 1, peakTreeThreads: 1, stdoutTail: lines, stderr: [], samples: [], environment: {} }; }
test('verification requires a fresh stage nonce and one receipt, not just exit zero', () => {
  expect(verifyReceipt(observation([receipt('a')]), 'app-assembly', 'a')).toContain('actual');
  for (const lines of [[], [receipt('old')], [receipt('a', 'update')], [receipt('a'), receipt('a')]]) expect(() => verifyReceipt(observation(lines), 'app-assembly', 'a')).toThrow();
});
async function workspace(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'bunly-release-test-'));
  try {
    await writeFile(join(directory, 'run.mjs'), 'import {mkdirSync,writeFileSync} from "node:fs";mkdirSync("app");writeFileSync("app/entry.js","export const value=42;");');
    await writeFile(join(directory, 'verify.mjs'), 'import {readFileSync} from "node:fs";if(readFileSync("app/entry.js","utf8")!=="export const value=42;")process.exit(2);console.log(JSON.stringify({event:"benchmark-verification",stage:process.env.BUNLY_BENCH_STAGE,nonce:process.env.BUNLY_BENCH_NONCE,passed:true,evidence:"Checked actual fixture output"}));');
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test('actual command execution, independent validation, and byte inventory', async () => workspace(async directory => {
  const v = plan(); const report = await runReleaseWorkflow({ ...v, tasks: { 'app-assembly': { ...task(), outputs: [{ category: 'installed', kind: 'directory', path: 'app', fresh: true }] } } }, { workspace: directory, output: join(directory, 'reports') });
  expect(report.passed).toBe(true); expect(report.fullStageCoverage).toBe(false); expect(report.stages).toHaveLength(9); expect(report.commands).toHaveLength(2);
  expect(report.bytes.find(v => v.category === 'installed')?.bytes).toBe(22);
  expect(report.bytes.find(v => v.category === 'first-run-download')?.bytes).toBe(null);
  expect(report.commands.every(v => v.observation?.cleanupSurvivors.length === 0)).toBe(true);
}), 30000);
test('fresh output guard rejects stale build even with a valid verifier', async () => workspace(async directory => {
  await mkdir(join(directory, 'app'));
  const report = await runReleaseWorkflow({ ...plan(), tasks: { 'app-assembly': { ...task(), outputs: [{ category: 'installed', kind: 'directory', path: 'app', fresh: true }] } } }, { workspace: directory, output: join(directory, 'reports') });
  expect(report.passed).toBe(false); expect(report.commands).toHaveLength(0); expect(report.bytes.every(r => r.bytes === null)).toBe(true);
}));
test('failed command blocks dependents; independent work may proceed', async () => workspace(async directory => {
  const v = structuredClone(plan()) as any; delete v.unsupported.update;
  v.tasks['app-assembly'].commands = [[process.execPath, '-e', 'process.exit(3)']];
  v.tasks.update = { ...task(), dependsOn: ['app-assembly'] };
  const report = await runReleaseWorkflow(v, { workspace: directory, output: join(directory, 'reports') });
  expect(report.passed).toBe(false); expect(report.commands).toHaveLength(1); expect(report.blockedBy.update).toEqual(['app-assembly']);
  expect(report.stages.find(s => s.stage === 'update')?.elapsedMs).toBe(null);
}), 30000);
test('rejected verification records no output measurements', async () => workspace(async directory => {
  await writeFile(join(directory, 'verify.mjs'), 'console.log("old verifier");');
  const report = await runReleaseWorkflow(plan(), { workspace: directory, output: join(directory, 'reports') });
  expect(report.passed).toBe(false); expect(report.commands).toHaveLength(2); expect(report.bytes.every(r => r.bytes === null)).toBe(true);
}), 30000);
test('cancelled stage is reaped before returning', async () => workspace(async directory => {
  const v = structuredClone(plan()) as any;
  v.tasks['app-assembly'].commands = [[process.execPath, '-e', 'setInterval(()=>{},1000)']]; v.tasks['app-assembly'].timeoutMs = 500;
  const report = await runReleaseWorkflow(v, { workspace: directory, output: join(directory, 'reports') });
  expect(report.passed).toBe(false); expect(report.cleanupEstablished).toBe(true); expect(report.commands).toHaveLength(1);
}), 30000);
test('linked output ancestors do not produce installed bytes', async () => workspace(async directory => {
  await mkdir(join(directory, 'other')); await symlink(join(directory, 'other'), join(directory, 'app'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await runReleaseWorkflow({ ...plan(), tasks: { 'app-assembly': { ...task(), outputs: [{ category: 'installed', kind: 'file', path: 'app/file.js', fresh: true }] } } }, { workspace: directory, output: join(directory, 'reports') });
  expect(report.passed).toBe(false); expect(report.commands).toHaveLength(0);
  expect(await readFile(join(directory, 'run.mjs'), 'utf8')).toContain('writeFileSync');
}));

test('archive stage executes compressor and verifies the full real payload independently', async () => workspace(async directory => {
  const python = process.env['PYTHON'] ?? 'python';
  const archiveScript = join(import.meta.dir, '../scripts/reference_archive.py');
  const v = structuredClone(plan()) as any;
  delete v.unsupported['installer-compress'];
  v.tasks['app-assembly'].outputs = [{ category: 'installed', kind: 'directory', path: 'app', fresh: true }];
  v.tasks['installer-compress'] = { ...task(), dependsOn: ['app-assembly'],
    commands: [[python, archiveScript, 'create', 'app', 'release/app.tar.gz']],
    verify: [python, archiveScript, 'verify', 'app', 'release/app.tar.gz'],
    outputs: [{ category: 'installer', kind: 'file', path: 'release/app.tar.gz', fresh: true }] };
  const report = await runReleaseWorkflow(v, { workspace: directory, output: join(directory, 'reports') });
  expect(report.passed).toBe(true); expect(report.fullStageCoverage).toBe(false);
  expect(report.commands).toHaveLength(4);
  expect(report.bytes.find(row => row.category === 'installed')?.bytes).toBe(22);
  expect(report.bytes.find(row => row.category === 'installer')?.bytes).toBeGreaterThan(0);
  expect(report.stages.find(row => row.stage === 'installer-compress')?.validation.evidence).toContain('archive members');
}), 30000);

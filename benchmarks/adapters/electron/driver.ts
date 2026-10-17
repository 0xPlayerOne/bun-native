import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createFixtureServer } from '../../fixtures/server.ts';
import { loadWorkbenchAssets } from '../../../scripts/workbench.ts';
import type { Trial, Variant } from '../../lib/results.ts';
const root = resolve(import.meta.dir, '../../..');
export const electronIdentity: Variant = { id: 'electron', framework: 'electron', version: '44.8.0', sourceCommit: '60169b45c12488c6fda237af7f6425526a7ce5f0',
  runtime: 'Node', runtimeVersion: 'unverified', engine: 'chromium', engineVersion: null, securityProfile: 'unverified', configuration: 'default' };
export async function electronScenario(scenario: string): Promise<Pick<Trial, 'status' | 'reason' | 'correctness' | 'metrics'>> {
  if (!['app-launch', 'navigation', 'lifecycle', 'terminal-render'].includes(scenario)) return { status: 'unsupported',
    reason: 'Not implemented by the initial Electron adapter; no synthetic timing substituted', correctness: { passed: false, details: 'No executed desktop scenario' }, metrics: {} };
  const executable = createRequire(import.meta.url)('electron') as string;
  const assets = await loadWorkbenchAssets();
  const fixture = await createFixtureServer(assets);
  const profile = await mkdtemp(join(tmpdir(), 'bunly-electron-profile-'));
  const directory = join(root, '.bunly/benchmarks/observations'); await mkdir(directory, { recursive: true });
  const observationPath = join(directory, randomUUID() + '.json');
  try {
    const process = Bun.spawn([globalThis.process.env['PYTHON'] ?? (globalThis.process.platform === 'win32' ? 'python' : 'python3'),
      join(root, 'scripts/observe-process.py'), '--output', observationPath, '--timeout', '25', '--', executable,
      join(import.meta.dir, 'main.cjs'), fixture.origin, scenario, profile], { stdout: 'inherit', stderr: 'inherit' });
    const code = await process.exited;
    const observed = JSON.parse(await readFile(observationPath, 'utf8')) as Record<string, unknown>;
    const reports = observed['reports'] as Record<string, unknown>[];
    const result = reports.at(-1);
    if (code !== 0 || observed['exitCode'] !== 0 || result?.['passed'] !== true) throw new Error(`Electron scenario failed; observation ${basename(observationPath)}; ${JSON.stringify(result ?? observed['stderr'])}`);
    electronIdentity.runtimeVersion = String(result['runtimeVersion']); electronIdentity.engineVersion = String(result['engineVersion']);
    electronIdentity.securityProfile = String(result['securityProfile']);
    const metrics: Trial['metrics'] = {
      mainEntryToReport: { value: Number(result['mainEntryToReportMs']), unit: 'ms' },
      peakTreeRss: { value: Number(observed['peakTreeRssBytes']), unit: 'bytes' },
      peakTreeThreads: { value: Number(observed['peakTreeThreads']), unit: 'count' } };
    if (typeof result['terminalConsumedAndPaintedMs'] === 'number') metrics['terminalConsumedAndPainted'] = { value: result['terminalConsumedAndPaintedMs'], unit: 'ms' };
    if (typeof result['navigationMs'] === 'number') metrics['navigation'] = { value: result['navigationMs'], unit: 'ms' };
    return { status: 'passed', reason: `Executed Electron fixture; raw observation ${basename(observationPath)}`, correctness: { passed: true, details: 'Trusted fixture completed; renderer sandbox checked; observed descendants cleaned' }, metrics };
  } finally { await fixture.close(); await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

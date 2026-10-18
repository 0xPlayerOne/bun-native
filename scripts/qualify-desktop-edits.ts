import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { cpus, release, totalmem } from 'node:os';
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts';
import { desktopEditTrial, DESKTOP_ADAPTERS, type DesktopAdapterName, type DesktopEditTrial } from '../benchmarks/adapters/desktop-edit/driver.ts';
const root = resolve(import.meta.dir, '..'), [selected, ...flags] = process.argv.slice(2);
if (!selected || !Object.hasOwn(DESKTOP_ADAPTERS, selected)) throw new Error('Usage: bun scripts/qualify-desktop-edits.ts electron|electrobun [--trials=3] [--warmups=1]');
const counts = { trials: 3, warmups: 1 }; const seenFlags = new Set<string>();
for (const flag of flags) {
  const match = /^--(trials|warmups)=(\d+)$/.exec(flag);
  if (!match || seenFlags.has(match[1]!) || Number(match[2]) > 20 || (match[1] === 'trials' && Number(match[2]) < 1)) throw new Error('Invalid desktop trial plan');
  seenFlags.add(match[1]!);
  counts[match[1] as keyof typeof counts] = Number(match[2]);
}
const adapter = selected as DesktopAdapterName;
async function fingerprint(paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const path of paths) { hash.update(path + '\0'); hash.update(await readFile(join(root, path))); hash.update('\0'); }
  return hash.digest('hex');
}
const sharedFixtureSha256 = await fingerprint(['benchmarks/fixtures/desktop-edit/index.html',
  'benchmarks/fixtures/desktop-edit/client.js', 'benchmarks/fixtures/desktop-edit/host.ts.txt',
  'examples/workbench/workbench.html', 'examples/workbench/ui.ts', 'benchmarks/fixtures/data.ts', 'benchmarks/fixtures/server.ts', 'benchmarks/fixtures/bun.lock']);
const adapterSha256 = await fingerprint(['benchmarks/lib/desktop-probe.ts', 'benchmarks/lib/desktop-edits.ts',
  'benchmarks/lib/source-identity.ts', 'benchmarks/lib/desktop-report.ts', 'benchmarks/lib/workbench-desktop.ts', 'scripts/workbench.ts', 'benchmarks/lib/stages.ts', 'benchmarks/lib/accounting.ts',
  'benchmarks/lib/observed-command.ts', 'scripts/observe-process.py', 'scripts/qualify-desktop-edits.ts',
  'benchmarks/adapters/desktop-edit/driver.ts', `benchmarks/fixtures/desktop-edit/${adapter}.ts.txt`,
  'benchmarks/fixtures/desktop-edit/preload.cjs.txt']);
const directory = join(root, '.bunly/benchmarks/desktop-edits', randomUUID()); await mkdir(directory, { recursive: true });
const controller = new AbortController();
const cancel = () => controller.abort(new Error('Desktop qualification interrupted'));
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const trials: { warmup: boolean; trial: number; status: 'passed' | 'failed' | 'not-executed'; result: DesktopEditTrial | null }[] = [];
let failed = false;
for (const warmup of [true, false]) for (let trial = 0; trial < (warmup ? counts.warmups : counts.trials); trial++) {
  if (failed) { trials.push({ warmup, trial, status: 'not-executed', result: null }); continue; }
  const result = await desktopEditTrial(adapter, join(directory, `${warmup ? 'warmup' : 'trial'}-${trial}`), controller.signal);
  failed = !result.passed; trials.push({ warmup, trial, status: result.passed ? 'passed' : 'failed', result });
}
const source = sourceIdentity(root);
const report = { schema: 1, adapter, framework: DESKTOP_ADAPTERS[adapter], createdAt: new Date().toISOString(),
  runClass: process.env['CI'] ? 'ci-smoke' : 'local-smoke', driverBun: Bun.version,
  sourceCommit: source.clean && source.commit ? source.commit : 'local-uncommitted', sourceObservation: source.reason, sharedFixtureSha256, adapterSha256, plan: counts, performanceEligible: false,
  environment: { platform: process.platform, arch: process.arch, os: release(), cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length, memoryBytes: totalmem(), gpu: 'unknown', power: 'unknown', display: 'unknown' },
  passed: !failed && trials.every(row => row.status === 'passed'), trials,
  limitations: ['Explicit stop-build-relaunch workflow, not stock watcher timing or managed hot reload',
    'Fixture-owned disk state is reconnected; windows/documents are expected to be replaced',
    'Electron builds only the main bundle and uses an external installed runtime; only Electrobun assembles an application directory',
    'Full shared workbench is rendered in a cross-origin sandboxed iframe; its preview is not a native child view',
    'Readiness requires the exact terminal bytes/checksum and both backend/page revision acknowledgements',
    'Completion-only loopback instrumentation is shared across frameworks and grants no native capability',
    'Electron uses a disclosed preliminary navigation to attest its sandbox; Electrobun process sandbox remains unverified',
    'Two animation callbacks prove a render opportunity, not physical presentation',
    'Setup and current-stage accounting are diagnostic; no signed release, download/update, or comparative performance claim'],
};
const destination = join(directory, 'report.json'); await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, report: destination, executed: trials.filter(row => row.status !== 'not-executed').length,
  failed: trials.filter(row => row.status === 'failed').map(row => row.result?.setupFailure ?? row.result?.result?.steps.filter(step => step.status === 'failed')) }));
process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
process.exitCode = controller.signal.aborted ? 130 : report.passed ? 0 : 1;

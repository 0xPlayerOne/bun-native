import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const out = join(root, '.bunly/qualification');
await mkdir(out, { recursive: true });
const target = `${process.platform}-${process.arch}`;
const library = process.platform === 'win32' ? 'bunly_host_probe.dll' : process.platform === 'darwin' ? 'libbunly_host_probe.dylib' : 'libbunly_host_probe.so';
const addon = join(out, 'probe.node');
await copyFile(join(root, 'native/target/release', library), addon);
const results: Record<string, unknown>[] = [];
let failures = 0;
for (const mode of ['ffi', 'napi'] as const) {
  for (const scenario of ['normal', 'hang']) {
    const file = join(out, `lifecycle-${target}-${mode}-${scenario}.json`);
    const proc = Bun.spawn([process.env['PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3'),
      join(root, 'scripts/observe-process.py'), '--output', file, '--timeout', '35', '--',
      process.execPath, join(root, 'scripts/probes/recreate.ts'), mode, addon, scenario], { stdout: 'inherit', stderr: 'inherit' });
    const code = await proc.exited;
    const report = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const reports = report['reports'] as Record<string, unknown>[];
    const passed = code === 0 && report['exitCode'] === 0 && reports.at(-1)?.['passed'] === true;
    if (!passed) failures++;
    results.push({ mode, scenario, passed, report: file.split(/[\\/]/).at(-1), peakTreeRssBytes: report['peakTreeRssBytes'], peakTreeThreads: report['peakTreeThreads'], observedProcesses: report['observedProcesses'] });
  }
}
// The same observer is applied to the native-owner/Bun-subprocess fallback.
const processFile = join(out, `lifecycle-${target}-process.json`);
const executable = join(root, 'native/target/release/bunly-host-probe' + (process.platform === 'win32' ? '.exe' : ''));
const child = Bun.spawn([process.env['PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3'),
  join(root, 'scripts/observe-process.py'), '--output', processFile, '--timeout', '15', '--', executable,
  process.execPath, join(root, 'scripts/probes/process-child.ts')], { stdout: 'inherit', stderr: 'inherit' });
const processCode = await child.exited;
const processReport = JSON.parse(await readFile(processFile, 'utf8')) as Record<string, unknown>;
const processPassed = processCode === 0 && processReport['exitCode'] === 0;
if (!processPassed) failures++;
results.push({ mode: 'process', passed: processPassed, report: processFile.split(/[\\/]/).at(-1), peakTreeRssBytes: processReport['peakTreeRssBytes'], peakTreeThreads: processReport['peakTreeThreads'], observedProcesses: processReport['observedProcesses'] });
const summary = { schema: 1, target, bun: Bun.version, commit: process.env['GITHUB_SHA'] ?? 'local',
  scope: 'ABI lifecycle qualification, not GUI performance', results, passed: failures === 0,
  limitations: ['Kernel wakeups require platform-specific instrumentation.', 'Process smoke workload differs from Worker soak: memory numbers are not a performance ranking.', 'Forced callback-owner destruction is tested only after native dispatch returns and is revoked.'] };
await writeFile(join(out, `lifecycle-summary-${target}.json`), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
assert.equal(failures, 0, 'Lifecycle qualification failed; inspect the raw reports');

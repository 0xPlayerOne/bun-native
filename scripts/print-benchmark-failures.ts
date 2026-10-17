import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
const directory = '.bunly/benchmarks';
try {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const value: unknown = await Bun.file(join(directory, name)).json();
    if (!value || typeof value !== 'object') continue;
    const report = value as Record<string, unknown>;
    if (Array.isArray(report['trials'])) {
      const failures = (report['trials'] as Record<string, unknown>[]).filter(trial => trial['status'] === 'failed');
      if (failures.length) console.error(JSON.stringify({ file: name, failedTrialsIncludingWarmups: failures }));
    }
    if (typeof report['exitCode'] === 'number' && report['exitCode'] !== 0) {
      console.error(JSON.stringify({ file: name, exitCode: report['exitCode'], stderr: report['stderr'], reports: report['reports'] }).slice(0, 48000));
    }
  }
} catch (error) { console.error('Benchmark diagnostics unavailable: ' + String(error)); }

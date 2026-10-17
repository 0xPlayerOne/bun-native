import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { phaseSummary, type ObservationSample } from '../benchmarks/lib/observation.ts';
test('phase accounting distinguishes sampled CPU, switches, and unavailable wakeups', () => {
  const samples: ObservationSample[] = [0, 100].map((elapsedMs, index) => ({ elapsedMs, phase: 'idle', rssBytes: 100, threads: 2,
    processes: [{ pid: 1, rssBytes: 100, threads: 2, cpuSeconds: index * 0.01, contextSwitches: index * 3, descriptors: 2 }] }));
  const row = phaseSummary(samples)[0]!;
  assert.equal(Math.round(row.treeCpuPercentOfOneCore!), 10);
  assert.equal(row.contextSwitches, 3); assert.equal(row.kernelWakeups, null);
});
test('single snapshots do not invent rate measurements', () => {
  const row = phaseSummary([{ elapsedMs: 0, phase: 'startup', rssBytes: 1, threads: 1, processes: [] }])[0]!;
  assert.equal(row.treeCpuPercentOfOneCore, null);
});

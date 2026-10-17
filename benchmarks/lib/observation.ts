export interface ProcessSample { pid: number; rssBytes: number; threads: number; cpuSeconds: number; contextSwitches: number | null; descriptors: number | null }
export interface ObservationSample { elapsedMs: number; phase: string; processes: ProcessSample[]; rssBytes: number; threads: number }
/** Per-phase diagnostic accounting. No substitution of context switches for wakeups. */
export function phaseSummary(samples: readonly ObservationSample[]) {
  return [...new Set(samples.map(sample => sample.phase))].map(phase => {
    const selected = samples.filter(sample => sample.phase === phase);
    let seconds = 0; let cpuSeconds = 0; let switches = 0; let hasSwitches = false;
    for (let index = 1; index < samples.length; index++) {
      const a = samples[index - 1]!; const b = samples[index]!;
      if (a.phase !== phase || b.phase !== phase) continue;
      const interval = (b.elapsedMs - a.elapsedMs) / 1000;
      if (interval <= 0) throw new Error('Non-monotonic observation');
      seconds += interval;
      for (const row of b.processes) {
        const old = a.processes.find(item => item.pid === row.pid); if (!old) continue;
        cpuSeconds += Math.max(0, row.cpuSeconds - old.cpuSeconds);
        if (row.contextSwitches !== null && old.contextSwitches !== null) { hasSwitches = true; switches += Math.max(0, row.contextSwitches - old.contextSwitches); }
      }
    }
    return { phase, samples: selected.length, sampledDurationMs: seconds * 1000,
      treeCpuPercentOfOneCore: seconds > 0 ? 100 * cpuSeconds / seconds : null,
      contextSwitches: hasSwitches ? switches : null, kernelWakeups: null,
      peakTreeRssBytes: Math.max(0, ...selected.map(sample => sample.rssBytes)),
      peakTreeThreads: Math.max(0, ...selected.map(sample => sample.threads)),
      note: 'Sampled process-tree diagnostics; context switches are not kernel wakeups; new/exited processes limit delta coverage.' };
  });
}

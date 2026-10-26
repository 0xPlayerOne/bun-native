/** Synthetic profile data for parser/CLI tests; not native performance evidence. */
import {
  TERMINAL_METRICS,
  TERMINAL_WORKLOAD_SOURCES,
  TERMINAL_MODES,
  type TerminalProfileCapture,
} from '../../benchmarks/lib/terminal-regression.ts'
const hex = (n: number) => n.toString(16).padStart(64, '0')
export function capture(shift = 0): TerminalProfileCapture {
  return {
    schema: 1,
    classification: 'validated-native-terminal-profile-capture',
    adapter: 'cef',
    source: 'a'.repeat(40),
    reportSha256: hex(1),
    context: {
      workload: {
        id: 'graphical-pty-window-load-v3',
        terminals: 2,
        recordsPerBatch: 32,
        phases: [
          { name: 'warmup', batches: 20, intervalMs: 100 },
          { name: 'ramp', batches: 40, intervalMs: 50 },
          { name: 'sustained', batches: 600, intervalMs: 50 },
          { name: 'recovery', batches: 40, intervalMs: 100 },
        ],
        maxBatchBytes: 32768,
        maxCallbacksPerBatch: 256,
        modes: TERMINAL_MODES,
      },
      runtime: {
        bun: '1.4.3',
        cef: '156.0.7',
        chromium: '156.0.8078.17',
        engineSha256: hex(2),
        terminalOwnership: 'native-non-detaching',
      },
      environment: {
        os: 'Darwin',
        release: 'fixture',
        arch: 'arm64',
        logicalCpus: 12,
        memoryBytes: 64 * 1024 ** 3,
        psutil: '7.0.0',
        python: '3.11.15',
        runClass: 'synthetic-parser-test-not-execution',
      },
      workloadSources: Object.fromEntries(
        TERMINAL_WORKLOAD_SOURCES.map((path, i) => [path, hex(i + 3)])
      ),
    },
    samples: TERMINAL_MODES.flatMap((mode, modeIndex) =>
      Array.from({ length: 5 }, (_, index) => ({
        mode,
        index,
        rawSha256: hex(30 + modeIndex * 5 + index),
        observationSha256: hex(80 + modeIndex * 5 + index),
        metrics: Object.fromEntries(
          TERMINAL_METRICS.map((metric) => [
            metric,
            metric === 'throughputBytesPerSecond' ? 1000 + index : 10 + index + shift,
          ])
        ) as TerminalProfileCapture['samples'][number]['metrics'],
      }))
    ),
  }
}

"""Separate, opt-in kernel-instrumented run; do not mix with plain observer timings."""
import argparse
import json
import runpy
from pathlib import Path
from kernel_counters import sample_counters, summarize_counters

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--require-counters', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command[1:] if options.command[:1] == ['--'] else options.command
    observe = runpy.run_path(str(Path(__file__).with_name('observe-process.py')))['observe']
    result = observe(command, options.timeout, counter_reader=sample_counters)
    result['kernelMeasurements'] = summarize_counters(result['samples'])
    result['accounting']['instrumentation'] = 'optional read-only per-OS kernel counters; not a power or cross-provider comparison'
    destination = Path(options.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'exitCode': result['exitCode'], 'timedOut': result['timedOut'],
                      'observedOrphans': result['observedOrphans'], 'kernelMeasurements': result['kernelMeasurements']}))
    failed = result['timedOut'] or result['outputOverflow'] or result['observedOrphans']
    if options.require_counters and result['kernelMeasurements']['status'] != 'observed':
        failed = True
    raise SystemExit(1 if failed else 0)

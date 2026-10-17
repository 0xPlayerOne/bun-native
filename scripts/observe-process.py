"""Bounded, out-of-process measurement. psutil is a contributor-only dependency.
RSS sums may double-count shared pages. Context switches are NOT kernel wakeups.
Only descendants observed with their creation time are eligible for cleanup.
"""
import argparse
import json
import os
import platform
import subprocess
import threading
import time
from pathlib import Path
import psutil


def observe(command, timeout=30.0, interval=0.025, max_samples=4000):
    if not command or timeout <= 0 or interval < 0.01:
        raise ValueError('Invalid bounded observation options')
    started = time.monotonic()
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=os.name != 'nt')
    root = psutil.Process(child.pid)
    known = {(root.pid, root.create_time()): root}
    lines, errors, samples = [], [], []
    state = {'phase': 'startup', 'bytes': 0, 'overflow': False}
    lock = threading.Lock()

    def drain(stream, output, phases=False):
        for raw in iter(lambda: stream.readline(65536), b''):
            with lock:
                state['bytes'] += len(raw)
                if state['bytes'] > 2 * 1024 * 1024:
                    state['overflow'] = True
                    continue
                text = raw.decode('utf-8', errors='replace').rstrip()
                output.append(text)
                if phases:
                    try:
                        item = json.loads(text)
                        if item.get('event') == 'phase':
                            state['phase'] = str(item.get('phase', 'unknown'))
                    except (ValueError, AttributeError):
                        pass
        stream.close()

    readers = [threading.Thread(target=drain, args=(child.stdout, lines, True), daemon=True),
               threading.Thread(target=drain, args=(child.stderr, errors), daemon=True)]
    for reader in readers:
        reader.start()

    def alive(identity, proc):
        try:
            return proc.create_time() == identity[1] and proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

    def snapshot():
        try:
            for proc in root.children(recursive=True):
                known[(proc.pid, proc.create_time())] = proc
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        rows = []
        for identity, proc in list(known.items()):
            if not alive(identity, proc):
                continue
            try:
                with proc.oneshot():
                    cpu = proc.cpu_times()
                    row = {'pid': identity[0], 'rssBytes': proc.memory_info().rss,
                           'threads': proc.num_threads(), 'cpuSeconds': cpu.user + cpu.system}
                    try:
                        switches = proc.num_ctx_switches()
                        row['contextSwitches'] = switches.voluntary + switches.involuntary
                    except (psutil.Error, AttributeError, NotImplementedError):
                        row['contextSwitches'] = None
                    try:
                        row['descriptors'] = proc.num_fds() if os.name != 'nt' else proc.num_handles()
                    except (psutil.Error, AttributeError, NotImplementedError):
                        row['descriptors'] = None
                    rows.append(row)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        with lock:
            phase = state['phase']
        return {'elapsedMs': (time.monotonic() - started) * 1000, 'phase': phase, 'processes': rows,
                'rssBytes': sum(row['rssBytes'] for row in rows), 'threads': sum(row['threads'] for row in rows)}

    timed_out = False
    while child.poll() is None:
        if len(samples) < max_samples:
            samples.append(snapshot())
        if time.monotonic() - started > timeout or state['overflow']:
            timed_out = True
            break
        time.sleep(interval)
    if timed_out:
        for identity, proc in reversed(list(known.items())):
            if alive(identity, proc):
                try:
                    proc.kill()
                except psutil.Error:
                    pass
        child.kill()
    try:
        code = child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        code = child.wait(timeout=5)
    for reader in readers:
        reader.join(timeout=2)
    survivors = [identity[0] for identity, proc in known.items() if identity[0] != child.pid and alive(identity, proc)]
    for identity, proc in known.items():
        if identity[0] in survivors and alive(identity, proc):
            try:
                proc.kill()
            except psutil.Error:
                pass
    reports = []
    for line in lines:
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get('event') != 'phase':
                reports.append(value)
        except ValueError:
            pass
    return {'schema': 1, 'exitCode': code, 'timedOut': timed_out, 'outputOverflow': state['overflow'],
            'elapsedMs': (time.monotonic() - started) * 1000, 'samples': samples, 'reports': reports,
            'stderr': errors[-20:], 'observedOrphans': survivors, 'observedProcesses': len(known),
            'peakTreeRssBytes': max((s['rssBytes'] for s in samples), default=0),
            'peakTreeThreads': max((s['threads'] for s in samples), default=0),
            'accounting': {'intervalMs': interval * 1000, 'sampleCap': max_samples,
                           'rss': 'sum of observed resident sets; shared pages may be counted more than once',
                           'descriptors': 'handles on Windows; file descriptors on POSIX',
                           'wakeups': None, 'wakeupsUnavailable': 'psutil has no portable kernel-wakeup counter; context switches are not relabeled',
                           'coverage': 'sampling can miss very short-lived descendants; known survivors are failures even if cleanup succeeds'},
            'environment': {'os': platform.system(), 'release': platform.release(), 'arch': platform.machine(),
                            'logicalCpus': psutil.cpu_count(), 'memoryBytes': psutil.virtual_memory().total,
                            'psutil': psutil.__version__, 'python': platform.python_version(), 'runClass': 'ci-smoke' if os.getenv('CI') else 'local-smoke'}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command[1:] if options.command[:1] == ['--'] else options.command
    result = observe(command, options.timeout)
    destination = Path(options.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: result[key] for key in ('exitCode', 'timedOut', 'observedOrphans', 'observedProcesses', 'peakTreeRssBytes', 'peakTreeThreads')}))
    raise SystemExit(1 if result['timedOut'] or result['outputOverflow'] or result['observedOrphans'] else 0)

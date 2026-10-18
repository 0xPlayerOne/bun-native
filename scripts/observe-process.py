"""Bounded process-tree observation. psutil is a contributor-only dependency.
RSS sums may double-count shared pages. Context switches are NOT kernel wakeups.
Only descendants observed with their creation time are eligible for cleanup.
"""
import argparse
import json
import os
import platform
import signal
import subprocess
import threading
import time
from pathlib import Path
import psutil

OUTPUT_LIMIT = 2 * 1024 * 1024


def observe(command, timeout=30.0, interval=0.025, max_samples=4000, counter_reader=None, stop_event=None):
    if not command or timeout <= 0 or interval < 0.01 or max_samples < 1:
        raise ValueError('Invalid bounded observation options')
    started = time.monotonic()
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=os.name != 'nt')
    try:
        root = psutil.Process(child.pid)
        known = {(root.pid, root.create_time()): root}
    except psutil.NoSuchProcess:
        root, known = None, {}
    lines, errors, samples = [], [], []
    state = {'phase': 'startup', 'bytes': 0, 'overflow': False}
    lock = threading.Lock()

    def drain(stream, output, phases=False):
        for raw in iter(lambda: stream.readline(OUTPUT_LIMIT + 1), b''):
            with lock:
                state['bytes'] += len(raw)
                if state['bytes'] > OUTPUT_LIMIT:
                    state['overflow'] = True
                    continue
                text = raw.decode('utf-8', errors='replace').rstrip()
                output.append(text)
                if phases:
                    try:
                        item = json.loads(text)
                        if isinstance(item, dict) and item.get('event') == 'phase':
                            state['phase'] = str(item.get('phase', 'unknown'))
                    except ValueError:
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
            if root is not None:
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
                    row = {'pid': identity[0], 'creationTime': identity[1], 'rssBytes': proc.memory_info().rss,
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
                if counter_reader is not None:
                    row['kernelCounters'] = counter_reader(identity[0])
                if alive(identity, proc):
                    rows.append(row)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        with lock:
            phase = state['phase']
        return {'elapsedMs': (time.monotonic() - started) * 1000, 'phase': phase, 'processes': rows,
                'rssBytes': sum(row['rssBytes'] for row in rows), 'threads': sum(row['threads'] for row in rows)}

    timed_out = False
    cancelled = False
    while child.poll() is None:
        if stop_event is not None and stop_event.is_set():
            cancelled = True
            break
        if len(samples) < max_samples:
            samples.append(snapshot())
        if time.monotonic() - started > timeout or state['overflow']:
            timed_out = True
            break
        time.sleep(interval)
    if timed_out or cancelled:
        # Discover still-owned descendants once more before interrupting the
        # root. This is bounded sampling, not a claim of kernel process tracking.
        if len(samples) < max_samples:
            samples.append(snapshot())
        else:
            snapshot()
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
    grace = time.monotonic() + .5
    while time.monotonic() < grace and any(identity[0] != child.pid and alive(identity, proc) for identity, proc in known.items()):
        time.sleep(interval)
    survivors = [identity[0] for identity, proc in known.items() if identity[0] != child.pid and alive(identity, proc)]
    orphan_details = []
    for identity, proc in known.items():
        if identity[0] not in survivors or not alive(identity, proc):
            continue
        detail = {'pid': identity[0], 'creationTime': identity[1], 'name': None,
                  'parentPid': None, 'browserRole': None}
        try:
            detail['name'] = proc.name()[:256]
            detail['parentPid'] = proc.ppid()
            # Only retain an allowlisted browser role, never the full command
            # line (which may contain URLs, paths or application credentials).
            roles = {'renderer', 'gpu-process', 'utility', 'zygote', 'crashpad-handler'}
            for arg in proc.cmdline():
                if arg.startswith('--type=') and arg[7:] in roles:
                    detail['browserRole'] = arg[7:]
                    break
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            detail['identityDetailsUnavailable'] = True
        orphan_details.append(detail)
    for identity, proc in known.items():
        if identity[0] in survivors and alive(identity, proc):
            try:
                proc.kill()
            except psutil.Error:
                pass
    cleanup_deadline = time.monotonic() + 1
    while time.monotonic() < cleanup_deadline and any(alive(identity, proc) for identity, proc in known.items()):
        time.sleep(interval)
    cleanup_survivors = [identity[0] for identity, proc in known.items() if alive(identity, proc)]
    for reader in readers:
        reader.join(timeout=2)
    reports = []
    for line in lines:
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get('event') != 'phase':
                reports.append(value)
        except ValueError:
            pass
    return {'schema': 1, 'exitCode': code, 'timedOut': timed_out, 'cancelled': cancelled, 'cleanupSurvivors': cleanup_survivors, 'outputOverflow': state['overflow'],
            'elapsedMs': (time.monotonic() - started) * 1000, 'samples': samples, 'reports': reports,
            'stdoutTail': lines[-40:], 'stderr': errors[-20:], 'observedOrphans': survivors, 'orphanDetails': orphan_details, 'observedProcesses': len(known),
            'peakTreeRssBytes': max((s['rssBytes'] for s in samples), default=0),
            'peakTreeThreads': max((s['threads'] for s in samples), default=0),
            'accounting': {'intervalMs': interval * 1000, 'sampleCap': max_samples, 'exitGraceMs': 500,
                           'rss': 'sum of observed resident sets; shared pages may be counted more than once',
                           'descriptors': 'handles on Windows; file descriptors on POSIX',
                           'wakeups': None, 'wakeupsUnavailable': 'No generic portable wakeup value; optional provider-specific counters are separate',
                           'coverage': 'sampling can miss very short-lived descendants; known survivors are failures even if cleanup succeeds'},
            'environment': {'os': platform.system(), 'release': platform.release(), 'arch': platform.machine(),
                            'logicalCpus': psutil.cpu_count(), 'memoryBytes': psutil.virtual_memory().total,
                            'psutil': psutil.__version__, 'python': platform.python_version(), 'runClass': 'ci-smoke' if os.getenv('CI') else 'local-smoke'}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--observation-id')
    parser.add_argument('--control-id')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    if options.observation_id is not None and (len(options.observation_id) != 48 or
            any(char not in '0123456789abcdef' for char in options.observation_id)):
        parser.error('Invalid observation identity')
    if options.control_id is not None and options.control_id != options.observation_id:
        parser.error('Control identity must match the observation identity')
    command = options.command[1:] if options.command[:1] == ['--'] else options.command
    stop_event = threading.Event()
    signal.signal(signal.SIGTERM, lambda _number, _frame: stop_event.set())
    signal.signal(signal.SIGINT, lambda _number, _frame: stop_event.set())
    if options.control_id is not None:
        # Read the private parent pipe without holding sys.stdin's buffered lock
        # during interpreter shutdown. Input sent before startup remains buffered.
        def control():
            packet = bytearray()
            try:
                while len(packet) <= 128 and b'\n' not in packet:
                    part = os.read(0, 128 - len(packet) + 1)
                    if not part:
                        # Losing the controlling parent also requests cleanup.
                        stop_event.set()
                        return
                    packet.extend(part)
                if bytes(packet) == ('cancel ' + options.control_id + '\n').encode('ascii'):
                    stop_event.set()
                else:
                    # Malformed private control input must never leave work running.
                    stop_event.set()
            except OSError:
                stop_event.set()
        threading.Thread(target=control, daemon=True).start()
    result = observe(command, options.timeout, stop_event=stop_event)
    if options.observation_id is not None:
        result['observationId'] = options.observation_id
    destination = Path(options.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: result[key] for key in ('exitCode', 'timedOut', 'observedOrphans', 'orphanDetails', 'observedProcesses', 'peakTreeRssBytes', 'peakTreeThreads')}))
    raise SystemExit(1 if result['timedOut'] or result['cancelled'] or result['outputOverflow'] or result['observedOrphans'] or result['cleanupSurvivors'] else 0)

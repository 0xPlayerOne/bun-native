import { expect, test } from 'bun:test'

// Exercise the diagnostic's acceptance boundary, including a deliberately
// retained target and failures that must never be counted as retention.
test('headless retention classification fails closed for unrelated failures', () => {
  const python = String.raw`
import copy, importlib.util, json, pathlib, tempfile
spec = importlib.util.spec_from_file_location('control', 'benchmarks/retention/headless-adapter-control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
expected = json.loads(pathlib.Path('toolchain.json').read_text())['bun']['revision']
runtime = control.resolve_runtime('bun', expected)
assert control.resolve_runtime(str(runtime), expected) == runtime
assert len(control.digest(runtime)) == 64
assert control.narrow_scan_setting({}) is None
assert control.narrow_scan_setting({'BUN_JSC_useNarrowReferenceScan': '0'}) == '0'
assert control.narrow_scan_setting({'BUN_JSC_useNarrowReferenceScan': '1'}) == '1'
assert control.effective_narrow_scan('  useNarrowReferenceScan=false (default: true)\n') is False
assert control.effective_narrow_scan('  useNarrowReferenceScan=true (default: true)\n') is True
for dump in ('unrelated', ' useNarrowReferenceScan=false\n useNarrowReferenceScan=true\n'):
    try:
        control.effective_narrow_scan(dump)
        raise AssertionError('invalid option dump accepted')
    except ValueError:
        pass
try:
    control.narrow_scan_setting({'BUN_JSC_useNarrowReferenceScan': 'invalid'})
    raise AssertionError('invalid narrow scan setting accepted')
except ValueError:
    pass
try:
    control.resolve_runtime(str(runtime), 'wrong-revision')
    raise AssertionError('wrong runtime revision accepted')
except ValueError as error:
    assert 'revision mismatch' in str(error)
revision = 'test-revision'
raw = {
    'adapter': 'react', 'bunRevision': revision, 'nonce': 'development-0',
    'declaredMode': 'development', 'status': 'passed',
    'workload': {'iterations': 10, 'rotations': 10, 'mounts': 2, 'rows': 32, 'warmup': 20},
    'cleanup': dict.fromkeys(('windows', 'nodes', 'callbacks', 'queuedTransactions', 'queuedCallbacks', 'activeCallbacks', 'serviceRequests'), 0),
    'retentionObservation': {'firstReachable': [], 'stillReachable': [], 'collectionCheckpoints': 2, 'probesPerMount': 3, 'probeKinds': ['render root', 'content node', 'listener']},
}
assert control.valid_report(raw, 'react', 'development', 0, revision, 0)
retained = copy.deepcopy(raw)
retained['status'] = 'failed'
retained['error'] = 'Disposed view/callback targets remain observable'
retained['retentionObservation']['stillReachable'] = [3]
assert control.valid_report(retained, 'react', 'development', 0, revision, 1)
for mutation in ('cleanup', 'index', 'unrelated', 'adapter', 'workload'):
    bad = copy.deepcopy(retained)
    if mutation == 'cleanup': bad['cleanup']['callbacks'] = 1
    if mutation == 'index': bad['retentionObservation']['stillReachable'] = [6]
    if mutation == 'unrelated': bad['error'] = 'peer failed'
    if mutation == 'adapter': bad['adapter'] = 'solid'
    if mutation == 'workload': bad['workload']['mounts'] = 1
    assert not control.valid_report(bad, 'react', 'development', 0, revision, 1), mutation

spec = importlib.util.spec_from_file_location('dispatch', 'benchmarks/retention/react-dispatch-control.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
command = dispatch.control_command('peer', 'module', 'binary', 'output', None)
assert command[-5:] == ['peer', 'module', 'binary', 'output', '1']
assert dispatch.control_command('peer', 'module', 'binary', 'output', '/runtime with spaces') == command + ['/runtime with spaces']
source = 'before\ndispose: () => view.dispose(),\nafter'
baseline = dispatch.variant_source(source, False)
clear = dispatch.variant_source(source, True)
assert baseline.replace('await view.dispose();', 'await view.dispose(); setText = undefined!; setRows = undefined!;') == clear
assert 'before\n' in clear and '\nafter' in clear
with tempfile.TemporaryDirectory() as directory:
    saved = pathlib.Path(directory) / 'variant.tsx'
    dispatch.save_variant(saved, clear)
    assert saved.read_bytes() == clear.encode('utf-8')
for invalid in ('no marker', source + source):
    try:
        dispatch.variant_source(invalid, False)
        raise AssertionError('invalid fixture marker accepted')
    except ValueError:
        pass
fixture = pathlib.Path('benchmarks/solid/react.tsx').read_text()
workload = pathlib.Path('benchmarks/solid/workload.ts').read_text()
spec = importlib.util.spec_from_file_location('boundary', 'benchmarks/retention/boundary-snapshot-control.py')
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
instrumented_boundary = boundary.workload_variant(workload)
gc_boundary = boundary.workload_variant(workload, False)
assert instrumented_boundary.count('generateHeapSnapshotForDebugging') == 1
assert 'generateHeapSnapshotForDebugging' not in gc_boundary
assert "assert.equal(stillReachable.length, 0" in gc_boundary
assert 'boundaryTargets = probes.flatMap' in gc_boundary
assert "'.boundary-targets.json'" in gc_boundary
assert "assert.equal(stillReachable.length, 0" in instrumented_boundary
assert instrumented_boundary.index('const stillReachable =') < instrumented_boundary.index('boundaryFile =')
assert instrumented_boundary.index('const boundaryTargets =') < instrumented_boundary.index('await Bun.sleep(1)\n      Bun.gc(true)\n      const firstReachable')
assert '__boundaryPin = view' in boundary.entry_variant(fixture, True)
assert '__boundaryPin' not in boundary.entry_variant(fixture, False)
released = boundary.release_wrapper_callbacks(gc_boundary)
assert "assert.equal(stillReachable.length, 0" in released
for name in ('update', 'rotate', 'dispose', 'inspect'):
    assert 'view.' + name + ' = undefined!' in released
assert released.index('const state = view.inspect()') < released.index('view.inspect = undefined!')
assert released.index('assert.equal(state.unexpectedClicks, 0)') < released.index('view.dispose = undefined!')
for invalid in ('missing marker', gc_boundary + gc_boundary):
    try:
        boundary.release_wrapper_callbacks(invalid)
        raise AssertionError('invalid wrapper marker accepted')
    except ValueError:
        pass
for function, original in ((boundary.workload_variant, workload), (lambda value: boundary.entry_variant(value, False), fixture)):
    for invalid in ('missing marker', original + original):
        try:
            function(invalid)
            raise AssertionError('invalid boundary marker accepted')
        except ValueError:
            pass
observed = dispatch.first_observation_workload(workload, False)
omitted = dispatch.first_observation_workload(workload, True)
assert observed == workload
first = '      const firstReachable = probes.flatMap((probe, index) =>\n        probe.deref() === undefined ? [] : [index]\n      )\n'
assert observed.replace(first, '      const firstReachable: number[] = []\n') == omitted
assert omitted.count('probe.deref() === undefined ? [] : [index]') == workload.count('probe.deref() === undefined ? [] : [index]') - 1
assert "assert.equal(stillReachable.length, 0" in omitted
assert omitted.count('Bun.gc(true)') == workload.count('Bun.gc(true)')
for invalid in ('no marker', workload + workload):
    for skip in (True, False):
        try:
            dispatch.first_observation_workload(invalid, skip)
            raise AssertionError('invalid first-observation marker accepted')
        except ValueError:
            pass
cycle_baseline = dispatch.cycle_workload(workload, 'baseline')
cycle_clear = dispatch.cycle_workload(workload, 'clear')
cycle_pin = dispatch.cycle_workload(workload, 'pin')
assert cycle_baseline.replace('        return cycleProbes\n', '        view = undefined\n        return cycleProbes\n') == cycle_clear
assert '__cycleDiagnosticPin = view' in cycle_pin
assert 'assert.equal(stillReachable.length, 0' in cycle_clear
assert dispatch.cycle_pin_valid(retained, 'development')
assert not dispatch.cycle_pin_valid(raw, 'development')
assert not dispatch.cycle_pin_valid(retained, 'aot')
for invalid in ('no marker', workload + workload):
    try:
        dispatch.cycle_workload(invalid, 'clear')
        raise AssertionError('invalid cycle marker accepted')
    except ValueError:
        pass
instrumented = dispatch.shutdown_workload(workload)
assert "beforeShutdownDiagnostic" in instrumented and "afterShutdownDiagnostic" in instrumented
assert "assert.equal(stillReachable.length, 0" in instrumented
baseline = dispatch.shutdown_entry(fixture, False)
pinned = dispatch.shutdown_entry(fixture, True)
assert '__retentionDiagnosticPin' not in baseline and '__retentionDiagnosticPin' in pinned
assert dispatch.shutdown_record_valid(raw, 'development', False)
assert not dispatch.shutdown_record_valid(raw, 'development', True)
after = copy.deepcopy(retained)
after['beforeShutdownDiagnostic'] = [3]
after['afterShutdownDiagnostic'] = [3]
assert dispatch.shutdown_record_valid(after, 'development', True)
after['afterShutdownDiagnostic'] = []
assert not dispatch.shutdown_record_valid(after, 'development', True)
after['afterShutdownDiagnostic'] = [6]
assert not dispatch.shutdown_record_valid(after, 'development', False)
`
  const result = Bun.spawnSync(
    [process.platform === 'win32' ? 'python' : 'python3', '-c', python],
    {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

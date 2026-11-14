import { expect, test } from 'bun:test'

// Exercise the diagnostic's acceptance boundary, including a deliberately
// retained target and failures that must never be counted as retention.
test('headless retention classification fails closed for unrelated failures', () => {
  const python = String.raw`
import copy, importlib.util, pathlib, tempfile
spec = importlib.util.spec_from_file_location('control', 'benchmarks/retention/headless-adapter-control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
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

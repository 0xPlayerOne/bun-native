import { expect, test } from 'bun:test'

// Exercise the diagnostic's acceptance boundary, including a deliberately
// retained target and failures that must never be counted as retention.
test('headless retention classification fails closed for unrelated failures', () => {
  const python = String.raw`
import copy, importlib.util
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

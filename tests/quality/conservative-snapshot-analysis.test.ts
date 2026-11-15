import { expect, test } from 'bun:test'

test('experimental conservative snapshot analysis follows strong edges and fails closed', () => {
  const python = String.raw`
import importlib.util
spec = importlib.util.spec_from_file_location('conservative', 'benchmarks/retention/conservative-snapshot-analysis.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
safe_spec = importlib.util.spec_from_file_location('safe', 'benchmarks/retention/snapshot_safe_run.py')
safe = importlib.util.module_from_spec(safe_spec)
safe_spec.loader.exec_module(safe)
assert safe.safe_environment({'PATH': '/bin', 'SystemRoot': 'system', 'SECRET_TOKEN': 'redacted'}) == {'PATH': '/bin', 'SystemRoot': 'system'}
snapshot = {
    'nodes': [1, 0, 0, 0, 0, '0x10', '0x0', 2, 0, 1, 0, 0, '0x20', '0x0', 3, 0, 2, 0, 0, '0x30', '0x0', 4, 0, 1, 0, 0, '0x40', '0x0'],
    'nodeClassNames': ['Object', 'Target', 'WeakRef'],
    'edges': [1, 2, 0, 0, 1, 3, 0, 0, 3, 4, 0, 0],
    'conservativeRoots': [1],
}
result = module.analyze(snapshot, [{'index': 0, 'address': '0X0020'}, {'index': 1, 'address': '0x40'}, {'index': 2, 'address': '0x99'}])
assert result['conservativeRootCount'] == 1
assert [step['node'] for step in result['targets'][0]['conservativePath']] == [1, 2]
assert result['targets'][1]['present'] and result['targets'][1]['conservativePath'] == []
assert not result['targets'][2]['present']
for roots in ([1, 1], [99]):
    try:
        module.analyze({**snapshot, 'conservativeRoots': roots}, [])
        raise AssertionError('invalid root list accepted')
    except ValueError:
        pass
try:
    module.analyze({key: value for key, value in snapshot.items() if key != 'conservativeRoots'}, [])
    raise AssertionError('missing experimental field accepted')
except KeyError:
    pass
`
  const result = Bun.spawnSync(
    [process.platform === 'win32' ? 'python' : 'python3', '-c', python],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdout: 'pipe', stderr: 'pipe' }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

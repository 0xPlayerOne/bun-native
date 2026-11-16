import { expect, test } from 'bun:test'

test('renderer pair samples reject incomplete or invalid measurements', () => {
  const python = String.raw`
import copy, importlib.util
spec = importlib.util.spec_from_file_location('pairs', 'benchmarks/renderer/append_pairs.py')
pairs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pairs)
append = {'rows': 4000, 'samples': 200, 'timingsMs': [0.1] * 200, 'p50Ms': 0.1}
assert pairs.valid_sample('append', append)
for change in ('length', 'nan', 'zero', 'rows'):
    bad = copy.deepcopy(append)
    if change == 'length': bad['timingsMs'].pop()
    if change == 'nan': bad['timingsMs'][0] = float('nan')
    if change == 'zero': bad['p50Ms'] = 0
    if change == 'rows': bad['rows'] = 1000
    assert not pairs.valid_sample('append', bad), change
guard = {'results': [{'scenario': name, 'rows': 1667, 'samples': 1000, 'p50Ms': 0.1} for name in pairs.SCENARIOS]}
assert pairs.valid_sample('guard', guard)
guard['results'][0]['scenario'] = 'unexpected'
assert not pairs.valid_sample('guard', guard)
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

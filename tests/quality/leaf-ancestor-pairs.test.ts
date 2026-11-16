import { expect, test } from 'bun:test'

test('native leaf comparison rejects incomplete or duplicate preflight samples', () => {
  const python = String.raw`
import sys
sys.path.insert(0, 'benchmarks/protocol')
import leaf_ancestor_pairs as pairs
lines = [f'{name},{trial},100' for name in pairs.CASES for trial in range(5, 35)]
assert len(pairs.parse('\n'.join(lines))['depth8']) == 30
for broken in [lines[:-1], lines + [lines[0]], lines[:-1] + ['nonleaf,34,0'], lines[:-1] + ['other,34,1']]:
    try: pairs.parse('\n'.join(broken))
    except ValueError: pass
    else: raise AssertionError('Invalid measurement accepted')
`
  const result = Bun.spawnSync(
    [process.platform === 'win32' ? 'python' : 'python3', '-c', python],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdout: 'pipe', stderr: 'pipe' }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})

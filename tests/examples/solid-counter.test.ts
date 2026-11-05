import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSolid } from '../../scripts/solid-build.ts'

/** The committed tree below the render container and the example's own column box. */
function counter(clicks: number, input: string, rows: string[]) {
  return [
    'box',
    '  box',
    '    text:Bun Native Solid',
    `    text:Clicks: ${clicks}`,
    '    button:Increment',
    '    text:Native editable input',
    '    input:|Type here…',
    `    text:Input: ${input}`,
    '    box',
    ...rows.map((name) => `      text:${name}`),
  ]
}

test('solid-counter example mounts, reorders keyed rows on click, accepts input and disposes on close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-native-solid-counter-'))
  try {
    const application = await buildSolid(
      resolve(import.meta.dir, 'solid-counter-contract.tsx'),
      directory
    )
    const child = Bun.spawn([process.execPath, application], {
      env: {
        ...process.env,
        BUN_NATIVE_EXAMPLE_TEST_PEER: resolve(import.meta.dir, '../core/events-peer.ts'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, signal: child.signalCode, stderr }).toEqual({
      exit: 0,
      signal: null,
      stderr: '',
    })
    const report = JSON.parse(stdout)
    expect(report.initial).toEqual(counter(0, '', ['Alpha', 'Beta', 'Gamma']))
    expect(report.mounted).toEqual({
      rowsCreated: 3,
      rowsDisposed: 0,
      effects: 1,
      ownerDisposed: false,
    })
    // The example's handler records `solid-keyed-update` only after its own
    // mutation-budget check passes: Gamma and Alpha are moved, Beta removed.
    expect(report.clicked).toEqual(counter(1, '', ['Gamma', 'Alpha']))
    expect(report.afterClick).toEqual({
      rowsCreated: 3,
      rowsDisposed: 1,
      effects: 2,
      ownerDisposed: false,
    })
    expect(report.clickedTwice).toEqual(counter(2, '', ['Alpha', 'Beta', 'Gamma']))
    expect(report.input).toEqual(counter(2, 'native edit', ['Alpha', 'Beta', 'Gamma']))
    expect(report.evidence).toEqual([
      'solid-effect',
      'solid-effect',
      'click',
      'solid-keyed-update',
      'solid-effect',
      'click',
      'solid-keyed-update',
      'input',
    ])
    expect(report.closed).toEqual({
      nodes: 0,
      listeners: 0,
      stats: { rowsCreated: 4, rowsDisposed: 4, effects: 3, ownerDisposed: true },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

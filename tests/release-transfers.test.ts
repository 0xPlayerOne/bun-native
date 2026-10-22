import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runReleaseWorkflow,
  validateReleasePlan,
  type ReleasePlan,
  type ReleaseTask,
} from '../benchmarks/lib/release-workflow.ts'
import { STAGES } from '../benchmarks/lib/stages.ts'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function plan(tasks: ReleasePlan['tasks']): ReleasePlan {
  return {
    schema: 1,
    framework: 'Bun transfer qualification fixture',
    version: '1',
    sourceCommit: 'a'.repeat(40),
    tasks,
    unsupported: Object.fromEntries(
      STAGES.filter((s) => !Object.hasOwn(tasks, s)).map((s) => [
        s,
        'Not part of this integration fixture',
      ])
    ),
  }
}
const executeSource = `import { readFile, writeFile, mkdir } from 'node:fs/promises';
const stage = process.env.BUNLY_BENCH_STAGE, version = stage === 'first-run' ? 'v1' : 'v2';
const data = JSON.parse(await readFile('downloads/' + version + '.json', 'utf8'));
if (data.version !== version) throw new Error('Wrong downloaded revision');
await mkdir('installed', { recursive: true });
if (stage === 'first-run') await writeFile('installed/profile.json', JSON.stringify({ counter: 17 }));
else if (JSON.parse(await readFile('installed/profile.json', 'utf8')).counter !== 17) throw new Error('Lost profile before update');
await writeFile('installed/version.json', JSON.stringify(data));
`
const verifySource = `import { readFile } from 'node:fs/promises';
const stage = process.env.BUNLY_BENCH_STAGE, expected = stage === 'first-run' ? 'v1' : 'v2';
if (JSON.parse(await readFile('installed/version.json', 'utf8')).version !== expected) throw new Error('Installed revision mismatch');
if (JSON.parse(await readFile('installed/profile.json', 'utf8')).counter !== 17) throw new Error('Profile lost');
console.log(JSON.stringify({event:'benchmark-verification',stage,nonce:process.env.BUNLY_BENCH_NONCE,passed:true,evidence:'Independent local fixture inspection: exact installed revision and retained profile; not desktop execution'}));
`
async function fixture(
  run: (project: string, origin: string, versions: Record<string, Uint8Array>) => Promise<void>
) {
  const project = await mkdtemp(join(tmpdir(), 'bunly-release-transfer-'))
  const versions: Record<string, Uint8Array> = {
    v1: Buffer.from('{"version":"v1","data":"initial"}\n'),
    v2: Buffer.from('{"version":"v2","data":"updated payload, different size"}\n'),
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const name = new URL(request.url).pathname.slice(1),
        data = versions[name]
      return data ? new Response(Buffer.from(data)) : new Response('not found', { status: 404 })
    },
  })
  try {
    await writeFile(join(project, 'execute.ts'), executeSource)
    await writeFile(join(project, 'verify.ts'), verifySource)
    await run(project, server.url.origin, versions)
  } finally {
    await server.stop(true)
    await rm(project, { recursive: true, force: true })
  }
}
function task(origin: string, version: string, data: Uint8Array, update = false): ReleaseTask {
  return {
    dependsOn: update ? ['first-run'] : [],
    commands: [[process.execPath, 'execute.ts']],
    verify: [process.execPath, 'verify.ts'],
    outputs: update
      ? []
      : [{ category: 'installed', kind: 'directory', path: 'installed', fresh: true }],
    timeoutMs: 15000,
    transfer: {
      category: update ? 'update' : 'first-run-download',
      url: origin + '/' + version,
      allowedOrigins: [origin],
      allowLoopbackHttp: true,
      path: 'downloads/' + version + '.json',
      expectedBytes: data.byteLength,
      sha256: sha(data),
    },
  }
}
test('real first-run/update HTTP transfers and independent subprocess verifiers retain separate byte counts', async () => {
  await fixture(async (project, origin, versions) => {
    const result = await runReleaseWorkflow(
      plan({
        'first-run': task(origin, 'v1', versions.v1!),
        update: task(origin, 'v2', versions.v2!, true),
      }),
      { workspace: project, output: join(project, 'reports') }
    )
    expect(result.passed).toBe(true)
    expect(result.fullStageCoverage).toBe(false)
    expect(result.transfers).toHaveLength(2)
    expect(result.commands).toHaveLength(4)
    expect(result.bytes.find((b) => b.category === 'first-run-download')?.bytes).toBe(
      versions.v1!.byteLength
    )
    expect(result.bytes.find((b) => b.category === 'update')?.bytes).toBe(versions.v2!.byteLength)
    expect(result.bytes.find((b) => b.category === 'installed')?.accounting).toBe(
      'logical-directory'
    )
    expect(result.bytes.find((b) => b.category === 'installer')?.status).toBe('unavailable')
    expect(
      JSON.parse(await readFile(join(project, 'installed/version.json'), 'utf8')).version
    ).toBe('v2')
    expect(
      JSON.parse(await readFile(join(project, 'installed/profile.json'), 'utf8')).counter
    ).toBe(17)
  })
})
test('a corrupt initial transfer blocks execution and dependent update instead of running stale artifacts', async () => {
  await fixture(async (project, origin, versions) => {
    const first = task(origin, 'v1', versions.v1!)
    const result = await runReleaseWorkflow(
      plan({
        'first-run': { ...first, transfer: { ...first.transfer!, sha256: 'b'.repeat(64) } },
        update: task(origin, 'v2', versions.v2!, true),
      }),
      { workspace: project, output: join(project, 'reports') }
    )
    expect(result.passed).toBe(false)
    expect(result.commands).toHaveLength(0)
    expect(result.transfers[0]?.report.errorCode).toBe('TRANSFER_HASH_MISMATCH')
    expect(result.blockedBy.update).toEqual(['first-run'])
    expect(result.bytes.find((b) => b.category === 'first-run-download')?.status).toBe(
      'unavailable'
    )
    expect(result.cleanupEstablished).toBe(true)
  })
})
test('a successful transfer never turns a failed launch/verification into a passed first run', async () => {
  await fixture(async (project, origin, versions) => {
    const first = task(origin, 'v1', versions.v1!)
    const result = await runReleaseWorkflow(
      plan({ 'first-run': { ...first, commands: [[process.execPath, '-e', 'process.exit(7)']] } }),
      { workspace: project, output: join(project, 'reports') }
    )
    expect(result.passed).toBe(false)
    expect(result.stages.find((s) => s.stage === 'first-run')?.status).toBe('failed')
    expect(result.transfers[0]?.report.status).toBe('passed')
    expect(result.bytes.find((b) => b.category === 'first-run-download')?.bytes).toBe(
      versions.v1!.byteLength
    )
    expect(result.bytes.find((b) => b.category === 'installed')?.status).toBe('unavailable')
  })
})
test('download completion cannot stand in for the independent nonce-bound verifier', async () => {
  await fixture(async (project, origin, versions) => {
    const first = task(origin, 'v1', versions.v1!)
    const result = await runReleaseWorkflow(
      plan({
        'first-run': {
          ...first,
          verify: [
            process.execPath,
            '-e',
            'console.log(JSON.stringify({event:"benchmark-verification",stage:"first-run",nonce:"old",passed:true,evidence:"stale"}))',
          ],
        },
      }),
      { workspace: project, output: join(project, 'reports') }
    )
    expect(result.passed).toBe(false)
    expect(result.stages.find((s) => s.stage === 'first-run')?.reason).toContain('stale')
  })
})
test('transfer categories, byte boundaries and destinations cannot be conflated', () => {
  const first = task('http://127.0.0.1:1234', 'v1', Buffer.from('v1'))
  expect(() => validateReleasePlan(plan({ 'cold-install': first }))).toThrow()
  expect(() =>
    validateReleasePlan(
      plan({ 'first-run': { ...first, transfer: { ...first.transfer!, category: 'update' } } })
    )
  ).toThrow()
  expect(() =>
    validateReleasePlan(
      plan({
        'first-run': {
          ...first,
          outputs: [{ category: 'installed', path: 'downloads', kind: 'directory', fresh: true }],
        },
      })
    )
  ).toThrow()
  const next = task('http://127.0.0.1:1234', 'v2', Buffer.from('v2'), true)
  expect(() =>
    validateReleasePlan(
      plan({
        'first-run': first,
        update: { ...next, transfer: { ...next.transfer!, path: 'DOWNLOADS/V1.JSON' } },
      })
    )
  ).toThrow()
  expect(() =>
    validateReleasePlan(
      plan({
        'first-run': first,
        update: { ...next, transfer: { ...next.transfer!, path: 'downloads/v1.json/child.bin' } },
      })
    )
  ).toThrow()
  expect(() =>
    validateReleasePlan(
      plan({
        update: {
          ...next,
          dependsOn: [],
          outputs: [{ category: 'update', path: 'other.bin', kind: 'file', fresh: true }],
        },
      })
    )
  ).toThrow()
})

import { expect, test } from 'bun:test'
import { link, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptPreparedFileMetadata,
  capturePreparedFileMetadata,
} from '../benchmarks/reload/prepared-file-metadata.ts'

const hostPath = 'Contents/MacOS/bunly_host'
const stamp = (path = hostPath) => ({
  path,
  size: '10',
  mtimeNs: '100',
  ctimeNs: '100',
  device: '1',
  inode: '2',
  mode: '33261',
  uid: '501',
  gid: '20',
  links: '1',
})
/** Synthetic observation validates the parser only; it is not native evidence. */
const observation = () => ({
  schema: 1,
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  outputOverflow: false,
  cleanupSurvivors: [],
  observedOrphans: [],
  elapsedMs: 100,
  peakTreeRssBytes: 1,
  peakTreeThreads: 1,
  stdoutTail: [],
  stderr: [],
  samples: [],
  environment: { os: 'Darwin' },
  postExitCleanup: {
    schema: 1,
    profile: 'macos-verified-code-sign-clone-v1',
    passed: true,
    qualified: true,
    status: 'completed',
    elapsedMs: 100,
    limitMs: 3000,
    observedClones: 1,
    cloneInventory: {
      prelaunchEntries: 0,
      entryLimit: 256,
      scope: 'new-names-after-prelaunch-snapshot',
    },
    helpers: [
      {
        pid: 123,
        creationTime: 1,
        role: 'code-sign-clone-cleanup',
        executableSha256: 'a'.repeat(64),
        ownership: 'observed-root-child-and-matching-clone-inode',
        processExited: true,
        cloneRemoved: true,
        completed: true,
      },
    ],
  },
})
const changed = () => ({
  before: [stamp()],
  after: [{ ...stamp(), ctimeNs: '200' }],
  hostPath,
  target: 'darwin-arm64',
  observations: [observation()],
})

test('prepared file identity accepts unchanged metadata and explicitly records a proven clone ctime change', () => {
  expect(acceptPreparedFileMetadata({ ...changed(), after: [stamp()] })).toEqual({
    identityUnchanged: true,
    ctimeChangedPaths: [],
    ctimeChangeReason: 'none',
  })
  expect(acceptPreparedFileMetadata(changed())).toEqual({
    identityUnchanged: true,
    ctimeChangedPaths: [hostPath],
    ctimeChangeReason: 'verified-macos-code-sign-clone-link-lifecycle',
  })
  expect(
    acceptPreparedFileMetadata({ ...changed(), observations: [observation(), observation()] })
      .identityUnchanged
  ).toBe(true)
})

test('clone cleanup never permits rewriting or replacing prepared files', () => {
  for (const field of ['size', 'mtimeNs', 'device', 'inode', 'mode', 'uid', 'gid', 'links']) {
    expect(() =>
      acceptPreparedFileMetadata({
        ...changed(),
        after: [{ ...stamp(), ctimeNs: '200', [field]: '999' }],
      })
    ).toThrow()
  }
  for (const extra of [
    { target: 'linux-x64' },
    { target: 'win32-x64' },
    { observations: [] },
    { after: [{ ...stamp(), ctimeNs: '99' }] },
    { before: [{ ...stamp(), links: '2' }], after: [{ ...stamp(), ctimeNs: '200', links: '2' }] },
    { after: [{ ...stamp(), path: 'Contents/Resources/bun' }] },
    {
      before: [stamp('Contents/Resources/bun'), stamp()],
      after: [{ ...stamp('Contents/Resources/bun'), ctimeNs: '200' }, stamp()],
    },
  ])
    expect(() => acceptPreparedFileMetadata({ ...changed(), ...extra })).toThrow()
})

test('clone ctime exception requires positive unchanged cleanup policy and ordinary process exit', () => {
  const original = observation()
  for (const changedObservation of [
    { ...original, exitCode: 1 },
    { ...original, observedOrphans: [123] },
    { ...original, postExitCleanup: undefined },
    { ...original, postExitCleanup: { ...original.postExitCleanup, qualified: false } },
    { ...original, postExitCleanup: { ...original.postExitCleanup, elapsedMs: 3001 } },
    {
      ...original,
      postExitCleanup: {
        ...original.postExitCleanup,
        helpers: [{ ...original.postExitCleanup.helpers[0], cloneRemoved: false }],
      },
    },
  ])
    expect(() =>
      acceptPreparedFileMetadata({ ...changed(), observations: [changedObservation] })
    ).toThrow()
})

test('real file capture detects hard-link lifetime without mistaking it for byte replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-file-identity-'))
  const path = join(root, 'host')
  try {
    await writeFile(path, 'unchanged native bytes')
    const before = await capturePreparedFileMetadata(root, [{ path: 'host' }])
    await link(path, join(root, 'clone'))
    const linked = await capturePreparedFileMetadata(root, [{ path: 'host' }])
    await unlink(join(root, 'clone'))
    const after = await capturePreparedFileMetadata(root, [{ path: 'host' }])
    expect(linked[0]!.links).toBe('2')
    expect(after[0]!.links).toBe('1')
    for (const field of ['inode', 'device', 'size', 'mtimeNs', 'mode'] as const)
      expect(after[0]![field]).toBe(before[0]![field])
    expect(BigInt(after[0]!.ctimeNs)).toBeGreaterThanOrEqual(BigInt(before[0]!.ctimeNs))
    await expect(capturePreparedFileMetadata(root, [{ path: '../escape' }])).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

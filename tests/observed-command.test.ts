import { expect, test } from 'bun:test'
import {
  validateCommandObservation,
  assertCleanCommand,
  observationsPermitFixtureRemoval,
  observedCommand,
} from '../benchmarks/lib/observed-command.ts'
const input = () => ({
  schema: 1,
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  outputOverflow: false,
  cleanupSurvivors: [],
  observedOrphans: [],
  elapsedMs: 1,
  peakTreeRssBytes: 1,
  peakTreeThreads: 1,
  stdoutTail: [],
  stderr: [],
  samples: [],
  environment: { fixture: true },
})
test('process observations reject unknown or incomplete outcome data', () => {
  expect(() => validateCommandObservation(input())).not.toThrow()
  for (const extra of [
    { exitCode: null },
    { timedOut: undefined },
    { cancelled: 'no' },
    { elapsedMs: NaN },
    { cleanupSurvivors: null },
    { observedOrphans: [-1] },
  ]) {
    expect(() => validateCommandObservation({ ...input(), ...extra })).toThrow()
  }
})
test('timed-out, cancelled, orphaning and overflowing commands never validate clean', () => {
  for (const extra of [
    { timedOut: true },
    { cancelled: true },
    { outputOverflow: true },
    { observedOrphans: [1] },
    { cleanupSurvivors: [1] },
    { exitCode: 1 },
  ]) {
    expect(() => assertCleanCommand(validateCommandObservation({ ...input(), ...extra }))).toThrow()
  }
})
test('process identity and diagnostic shapes are bounded', () => {
  for (const extra of [
    { samples: [{ processes: [{ pid: 0 }] }] },
    { stdoutTail: [null] },
    { stderr: Array.from({ length: 41 }, () => 'x') },
    { environment: [] },
  ]) {
    expect(() => validateCommandObservation({ ...input(), ...extra })).toThrow()
  }
})

test('fixture deletion requires positive child cleanup evidence', () => {
  const clean = validateCommandObservation(input())
  expect(observationsPermitFixtureRemoval([])).toBe(true)
  expect(observationsPermitFixtureRemoval([clean])).toBe(true)
  expect(observationsPermitFixtureRemoval([clean, null])).toBe(false)
  expect(observationsPermitFixtureRemoval([{ ...clean, cleanupSurvivors: [123] }])).toBe(false)
  // An orphan remains a trial failure even if it has since been reaped.
  expect(observationsPermitFixtureRemoval([{ ...clean, observedOrphans: [123] }])).toBe(true)
})
test('invalid redaction configuration is rejected before process execution', () => {
  expect(() =>
    observedCommand([process.execPath, '-e', 'throw 1'], {
      cwd: import.meta.dir,
      output: 'never-written.json',
      redact: ['invalid-token'],
    })
  ).toThrow('Invalid redaction credential')
})

test('observation nonce is a bounded identity rather than arbitrary report text', () => {
  expect(() =>
    validateCommandObservation({ ...input(), observationId: 'a'.repeat(48) })
  ).not.toThrow()
  for (const observationId of [1, null, '', 'bad', 'a'.repeat(49)]) {
    expect(() => validateCommandObservation({ ...input(), observationId })).toThrow()
  }
})

const cleanup = () => ({
  schema: 1,
  profile: 'macos-verified-code-sign-clone-v1',
  limitMs: 3000,
  elapsedMs: 750,
  observedClones: 1,
  cloneInventory: {
    prelaunchEntries: 0,
    entryLimit: 256,
    scope: 'new-names-after-prelaunch-snapshot',
  },
  passed: true,
  qualified: true,
  status: 'completed',
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
})
test('cleanup acceptance requires consistent bounded process and clone evidence', () => {
  expect(() => validateCommandObservation({ ...input(), postExitCleanup: cleanup() })).not.toThrow()
  for (const extra of [
    { helpers: [] },
    { observedClones: 0 },
    { qualified: false },
    { status: 'not-observed' },
    { elapsedMs: 3001 },
    { observedClones: 257 },
    { helpers: [cleanup().helpers[0], cleanup().helpers[0]] },
    { helpers: [{ ...cleanup().helpers[0], cloneRemoved: false }] },
    { helpers: [{ ...cleanup().helpers[0], executableSha256: 'claimed' }] },
  ])
    expect(() =>
      validateCommandObservation({
        ...input(),
        postExitCleanup: { ...cleanup(), ...extra },
      })
    ).toThrow()
})
test('missing cleanup observation remains distinct from a qualified native cleanup', () => {
  const observation = validateCommandObservation({
    ...input(),
    postExitCleanup: {
      ...cleanup(),
      observedClones: 0,
      helpers: [],
      qualified: false,
      status: 'not-observed',
    },
  })
  expect(observation.postExitCleanup?.qualified).toBe(false)
  expect(() => assertCleanCommand(observation)).not.toThrow()
})
test('cleanup inventory requires bounded prelaunch scoping even when prior clones remain', () => {
  expect(() =>
    validateCommandObservation({
      ...input(),
      postExitCleanup: {
        ...cleanup(),
        cloneInventory: { ...cleanup().cloneInventory, prelaunchEntries: 1 },
      },
    })
  ).not.toThrow()
  for (const cloneInventory of [
    undefined,
    null,
    [],
    { ...cleanup().cloneInventory, scope: 'same-executable' },
    { ...cleanup().cloneInventory, entryLimit: 257 },
    { ...cleanup().cloneInventory, prelaunchEntries: -1 },
    { ...cleanup().cloneInventory, prelaunchEntries: 257 },
    { ...cleanup().cloneInventory, prelaunchEntries: '1' },
  ])
    expect(() =>
      validateCommandObservation({
        ...input(),
        postExitCleanup: { ...cleanup(), cloneInventory },
      })
    ).toThrow()
})
test('retained kernel ancestry uses bounded lossless IDs and an explicit proof kind', () => {
  const retained = {
    ...cleanup(),
    recovery: { attempted: true, candidates: 100, candidateLimit: 4096, scanLimit: 1 },
    helpers: [
      {
        ...cleanup().helpers[0],
        ownership: 'retained-kernel-parent-and-matching-clone-inode',
        kernelIdentity: {
          rootUniqueId: '9223372036854775808',
          uniqueId: '9223372036854775809',
          parentUniqueId: '9223372036854775808',
        },
      },
    ],
  }
  expect(() => validateCommandObservation({ ...input(), postExitCleanup: retained })).not.toThrow()
  for (const kernelIdentity of [
    null,
    { ...retained.helpers[0]!.kernelIdentity, parentUniqueId: '1' },
    { ...retained.helpers[0]!.kernelIdentity, uniqueId: Number('9223372036854775809') },
    { ...retained.helpers[0]!.kernelIdentity, uniqueId: '18446744073709551616' },
    { ...retained.helpers[0]!.kernelIdentity, uniqueId: '0' },
    { ...retained.helpers[0]!.kernelIdentity, uniqueId: '01' },
    { ...retained.helpers[0]!.kernelIdentity, uniqueId: '1'.repeat(1000) },
  ])
    expect(() =>
      validateCommandObservation({
        ...input(),
        postExitCleanup: {
          ...retained,
          helpers: [{ ...retained.helpers[0], kernelIdentity }],
        },
      })
    ).toThrow()
  for (const recovery of [
    undefined,
    { ...retained.recovery, candidates: 4097 },
    { ...retained.recovery, attempted: false },
    { ...retained.recovery, scanLimit: 2 },
  ])
    expect(() =>
      validateCommandObservation({
        ...input(),
        postExitCleanup: {
          ...retained,
          recovery,
        },
      })
    ).toThrow()
  expect(() =>
    validateCommandObservation({
      ...input(),
      postExitCleanup: {
        ...retained,
        helpers: [{ ...retained.helpers[0], ownership: 'argv-only' }],
      },
    })
  ).toThrow()
})
test('failed cleanup cannot authorize a clean command or fixture deletion', () => {
  const observation = validateCommandObservation({
    ...input(),
    postExitCleanup: { ...cleanup(), passed: false, qualified: false, status: 'failed' },
  })
  expect(() => assertCleanCommand(observation)).toThrow()
  expect(observationsPermitFixtureRemoval([observation])).toBe(false)
})

test('missing observer interpreter fails before applying target environment', () => {
  expect(() =>
    observedCommand([process.execPath, '-e', 'throw 1'], {
      cwd: import.meta.dir,
      output: 'never-written.json',
      env: { PATH: '' },
      observerCommand: ['bunly-missing-observer-interpreter-8bf2d19c'],
    })
  ).toThrow('Observer interpreter not found in caller environment')
})

test('native exit failure remains visible when post-exit cleanup also fails', () => {
  const observation = validateCommandObservation({
    ...input(),
    exitCode: 2,
    postExitCleanup: {
      ...cleanup(),
      passed: false,
      qualified: false,
      status: 'failed',
      helpers: [],
    },
  })
  expect(() => assertCleanCommand(observation)).toThrow(
    'Command failed: unexpected exit 2 (expected 0); post-exit cleanup failed'
  )
})

test('failure messages report exactly the observed flags across all combinations', () => {
  const descriptions = [
    'unexpected exit 2 (expected 0)',
    'observer timed out',
    'observation cancelled',
    'output overflow',
    'observed orphan count 1',
    'cleanup survivor count 1',
    'post-exit cleanup failed',
  ]
  for (let mask = 0; mask < 128; mask++) {
    const enabled = (bit: number) => Boolean(mask & (1 << bit))
    const observation = validateCommandObservation({
      ...input(),
      exitCode: enabled(0) ? 2 : 0,
      timedOut: enabled(1),
      cancelled: enabled(2),
      outputOverflow: enabled(3),
      observedOrphans: enabled(4) ? [123] : [],
      cleanupSurvivors: enabled(5) ? [456] : [],
      ...(enabled(6)
        ? {
            postExitCleanup: {
              ...cleanup(),
              passed: false,
              qualified: false,
              status: 'failed',
              helpers: [],
            },
          }
        : {}),
    })
    if (mask === 0) {
      expect(() => assertCleanCommand(observation)).not.toThrow()
    } else {
      expect(() => assertCleanCommand(observation)).toThrow(
        'Command failed: ' + descriptions.filter((_description, bit) => enabled(bit)).join('; ')
      )
    }
  }
})

test('an expected nonzero exit is accepted only when observation and cleanup are clean', () => {
  const observation = validateCommandObservation({ ...input(), exitCode: 2 })
  expect(() => assertCleanCommand(observation, 2)).not.toThrow()
  expect(() => assertCleanCommand({ ...observation, cancelled: true }, 2)).toThrow(
    'Command failed: observation cancelled'
  )
})

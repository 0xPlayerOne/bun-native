import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '../../scripts/quality/host-reproducibility.ts'
import {
  checkVerification,
  slsaProvenance,
  verifyCommand,
  verifyProvenance,
  type ProvenancePolicy,
  type Runner,
} from '../../scripts/quality/linux-provenance.ts'

const commit = 'c'.repeat(40)
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function archive(bytes = 'host archive bytes'): Promise<ProvenancePolicy> {
  const directory = await mkdtemp(join(tmpdir(), 'linux-provenance-'))
  temporary.push(directory)
  const file = join(directory, 'unsigned-native-host.tar.gz')
  await writeFile(file, bytes)
  return {
    file,
    repository: '0xPlayerOne/bun-native',
    signerWorkflow: '.github/workflows/native-linux.yml',
    sourceRef: 'refs/heads/main',
    sourceDigest: commit,
  }
}

/** The shape `gh attestation verify --format json` prints for one verified bundle. */
function verified(
  digest: string,
  certificate: Record<string, unknown> = {},
  predicate = slsaProvenance
) {
  return JSON.stringify([
    {
      attestation: { bundle: { verificationMaterial: { tlogEntries: [{ logIndex: '123456' }] } } },
      verificationResult: {
        statement: {
          _type: 'https://in-toto.io/Statement/v1',
          subject: [{ name: 'unsigned-native-host.tar.gz', digest: { sha256: digest } }],
          predicateType: predicate,
        },
        signature: {
          certificate: {
            buildSignerURI:
              'https://github.com/0xPlayerOne/bun-native/.github/workflows/native-linux.yml@refs/heads/main',
            sourceRepositoryURI: 'https://github.com/0xPlayerOne/bun-native',
            sourceRepositoryRef: 'refs/heads/main',
            sourceRepositoryDigest: commit,
            runnerEnvironment: 'github-hosted',
            runInvocationURI: 'https://github.com/0xPlayerOne/bun-native/actions/runs/1/attempts/1',
            ...certificate,
          },
        },
      },
    },
  ])
}

test('the verify command pins signer workflow, ref, commit, predicate and hosted runners', async () => {
  const policy = await archive()
  expect(verifyCommand(policy)).toEqual([
    'gh',
    'attestation',
    'verify',
    policy.file,
    '--repo',
    '0xPlayerOne/bun-native',
    '--signer-workflow',
    '0xPlayerOne/bun-native/.github/workflows/native-linux.yml',
    '--source-ref',
    'refs/heads/main',
    '--source-digest',
    commit,
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
    '--deny-self-hosted-runners',
    '--format',
    'json',
  ])
})

test('a verified attestation for the exact archive bytes passes', async () => {
  const policy = await archive()
  const digest = sha256(Buffer.from('host archive bytes'))
  const calls: string[][] = []
  const run: Runner = (command) => {
    calls.push(command)
    return { exitCode: 0, stdout: verified(digest), stderr: '' }
  }
  expect(verifyProvenance(policy, run)).toEqual({
    file: policy.file,
    sha256: digest,
    signer:
      'https://github.com/0xPlayerOne/bun-native/.github/workflows/native-linux.yml@refs/heads/main',
    sourceRepository: 'https://github.com/0xPlayerOne/bun-native',
    sourceRef: 'refs/heads/main',
    sourceDigest: commit,
    runInvocation: 'https://github.com/0xPlayerOne/bun-native/actions/runs/1/attempts/1',
    transparencyLogIndex: '123456',
  })
  expect(calls).toEqual([verifyCommand(policy)])
})

test('a failed gh verification fails with its message', async () => {
  const policy = await archive()
  const run: Runner = () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'no attestations found for subject\n',
  })
  expect(() => verifyProvenance(policy, run)).toThrow(
    'gh attestation verify failed (1): no attestations found for subject'
  )
})

test('an attestation for other bytes, signer, ref, commit, runner or predicate is refused', async () => {
  const policy = await archive()
  const digest = sha256(Buffer.from('host archive bytes'))
  const cases: [string, string][] = [
    [verified('0'.repeat(64)), `no subject has sha256 ${digest}`],
    [
      verified(digest, {
        buildSignerURI:
          'https://github.com/0xPlayerOne/bun-native/.github/workflows/other.yml@refs/heads/main',
      }),
      'is not https://github.com/0xPlayerOne/bun-native/.github/workflows/native-linux.yml@',
    ],
    [
      verified(digest, { sourceRepositoryURI: 'https://github.com/fork/bun-native' }),
      'source repository is',
    ],
    [
      verified(digest, { sourceRepositoryRef: 'refs/heads/feature' }),
      'source ref is refs/heads/feature',
    ],
    [verified(digest, { sourceRepositoryDigest: 'd'.repeat(40) }), 'source commit is'],
    [verified(digest, { runnerEnvironment: 'self-hosted' }), 'runner environment is self-hosted'],
    [verified(digest, {}, 'https://spdx.dev/Document/v2.3'), 'predicate is not SLSA provenance v1'],
  ]
  for (const [stdout, message] of cases)
    expect(() => checkVerification(stdout, policy, digest)).toThrow(message)
  expect(() => checkVerification('[]', policy, digest)).toThrow('no verified attestation')
  expect(() => checkVerification('not json', policy, digest)).toThrow('did not print JSON')
})

test('a malformed policy is refused before gh runs', async () => {
  const policy = await archive()
  const run: Runner = () => {
    throw new Error('gh must not run')
  }
  for (const [change, message] of [
    [{ file: 'relative.tar.gz' }, 'must be absolute'],
    [{ repository: 'no-owner' }, 'owner/name'],
    [{ signerWorkflow: 'native-linux.yml' }, '.github/workflows/NAME.yml'],
    [{ sourceRef: 'main' }, 'full ref'],
    [{ sourceDigest: 'abc' }, '40-hex commit'],
  ] as const)
    expect(() => verifyProvenance({ ...policy, ...change }, run)).toThrow(message)
})

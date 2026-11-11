import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { sha256 } from './host-reproducibility.ts'

/**
 * Verifies the keyless Sigstore build provenance that `native-linux.yml` attaches
 * to the Linux `unsigned-native-host.tar.gz` (#249, #223). GitHub's OIDC token
 * signs the SLSA statement through Sigstore's Fulcio CA; no key or secret exists.
 *
 * `gh attestation verify` checks the Sigstore bundle cryptographically (certificate
 * chain, transparency log inclusion, signature over the statement) and applies the
 * signer workflow, source ref, source commit and hosted-runner policy. This script
 * builds that exact policy and then re-checks the verified statement it returns, so
 * a policy flag that a future `gh` ignored or renamed still cannot pass.
 */

export const slsaProvenance = 'https://slsa.dev/provenance/v1'

export type ProvenancePolicy = {
  file: string
  /** owner/name of the repository whose workflow must have signed the attestation. */
  repository: string
  /** Repository-relative path of the signing (reusable) workflow. */
  signerWorkflow: string
  /** Full ref the build ran on, for example refs/heads/main. */
  sourceRef: string
  /** 40-hex commit the build checked out. */
  sourceDigest: string
}

type Command = { exitCode: number; stdout: string; stderr: string }
export type Runner = (command: string[]) => Command

const runCommand: Runner = (command) => {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: 300_000 })
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

export function verifyCommand(policy: ProvenancePolicy): string[] {
  return [
    'gh',
    'attestation',
    'verify',
    policy.file,
    '--repo',
    policy.repository,
    '--signer-workflow',
    `${policy.repository}/${policy.signerWorkflow}`,
    '--source-ref',
    policy.sourceRef,
    '--source-digest',
    policy.sourceDigest,
    '--predicate-type',
    slsaProvenance,
    '--deny-self-hosted-runners',
    '--format',
    'json',
  ]
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

type ProvenanceResult = {
  file: string
  sha256: string
  signer: string
  sourceRepository: string
  sourceRef: string
  sourceDigest: string
  runInvocation: string
  transparencyLogIndex?: string
}

/** Checks the JSON `gh attestation verify --format json` printed for `digest`. */
export function checkVerification(
  text: string,
  policy: ProvenancePolicy,
  digest: string
): ProvenanceResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('gh attestation verify did not print JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('gh attestation verify returned no verified attestation')
  const signerPrefix = `https://github.com/${policy.repository}/${policy.signerWorkflow}@`
  const problems: string[] = []
  for (const entry of parsed) {
    const result = record(record(entry)['verificationResult'])
    const statement = record(result['statement'])
    const certificate = record(record(result['signature'])['certificate'])
    const subjects = Array.isArray(statement['subject']) ? statement['subject'] : []
    const matched = subjects.some(
      (subject) => record(record(subject)['digest'])['sha256'] === digest
    )
    const signer = String(certificate['buildSignerURI'] ?? '')
    const checks: [boolean, string][] = [
      [statement['predicateType'] === slsaProvenance, 'predicate is not SLSA provenance v1'],
      [matched, `no subject has sha256 ${digest}`],
      [signer.startsWith(signerPrefix), `signer ${signer || '(none)'} is not ${signerPrefix}`],
      [
        certificate['sourceRepositoryURI'] === `https://github.com/${policy.repository}`,
        `source repository is ${String(certificate['sourceRepositoryURI'])}`,
      ],
      [
        certificate['sourceRepositoryRef'] === policy.sourceRef,
        `source ref is ${String(certificate['sourceRepositoryRef'])}`,
      ],
      [
        certificate['sourceRepositoryDigest'] === policy.sourceDigest,
        `source commit is ${String(certificate['sourceRepositoryDigest'])}`,
      ],
      [
        certificate['runnerEnvironment'] === 'github-hosted',
        `runner environment is ${String(certificate['runnerEnvironment'])}`,
      ],
    ]
    const failed = checks.filter(([ok]) => !ok).map(([, message]) => message)
    if (failed.length === 0) {
      const entries = record(record(record(entry)['attestation'])['bundle'])['verificationMaterial']
      const tlog = record(entries)['tlogEntries']
      const index = Array.isArray(tlog) ? record(tlog[0])['logIndex'] : undefined
      return {
        file: policy.file,
        sha256: digest,
        signer,
        sourceRepository: String(certificate['sourceRepositoryURI']),
        sourceRef: policy.sourceRef,
        sourceDigest: policy.sourceDigest,
        runInvocation: String(certificate['runInvocationURI'] ?? ''),
        ...(index === undefined ? {} : { transparencyLogIndex: String(index) }),
      }
    }
    problems.push(failed.join('; '))
  }
  throw new Error(`No attestation satisfies the provenance policy: ${problems.join(' | ')}`)
}

export function verifyProvenance(
  policy: ProvenancePolicy,
  run: Runner = runCommand
): ProvenanceResult {
  if (!isAbsolute(policy.file)) throw new Error('The attested file path must be absolute')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository))
    throw new Error(`Repository must be owner/name: ${policy.repository}`)
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(policy.signerWorkflow))
    throw new Error(`Signer workflow must be .github/workflows/NAME.yml: ${policy.signerWorkflow}`)
  if (!/^refs\/(heads|tags)\/\S+$/.test(policy.sourceRef))
    throw new Error(`Source ref must be a full ref: ${policy.sourceRef}`)
  if (!/^[0-9a-f]{40}$/.test(policy.sourceDigest))
    throw new Error(`Source digest must be a 40-hex commit: ${policy.sourceDigest}`)
  const digest = sha256(readFileSync(policy.file))
  const result = run(verifyCommand(policy))
  if (result.exitCode !== 0)
    throw new Error(
      `gh attestation verify failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`
    )
  return checkVerification(result.stdout, policy, digest)
}

function main(argv: string[], log: (line: string) => void = console.log): number {
  const usage =
    'usage: linux-provenance.ts verify FILE --repo OWNER/NAME --signer-workflow .github/workflows/NAME.yml --source-ref REF --source-digest SHA'
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      'signer-workflow': { type: 'string' },
      'source-ref': { type: 'string' },
      'source-digest': { type: 'string' },
    },
  })
  const [command, file, ...extra] = positionals
  if (command !== 'verify' || !file || extra.length > 0) throw new Error(usage)
  for (const key of ['repo', 'signer-workflow', 'source-ref', 'source-digest'] as const)
    if (!values[key]) throw new Error(`--${key} is required\n${usage}`)
  const result = verifyProvenance({
    file,
    repository: values.repo as string,
    signerWorkflow: values['signer-workflow'] as string,
    sourceRef: values['source-ref'] as string,
    sourceDigest: values['source-digest'] as string,
  })
  log(JSON.stringify(result, null, 2))
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))

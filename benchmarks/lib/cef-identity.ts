import { resolve } from 'node:path'
import { observedCommand, assertCleanCommand, type CommandObservation } from './observed-command.ts'
export interface CefIdentity {
  readonly event: 'cef-binary-identity'
  readonly schema: 1
  readonly sha256: string
  readonly cefVersion: string
  readonly cefCommitNumber: number
  readonly chromiumVersion: string
  readonly fullVersion: string | null
  readonly source: 'exported-api'
  readonly sandbox: 'unverified'
}
export function parseCefIdentity(input: unknown, expectedHash: string): CefIdentity {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Missing CEF identity')
  const v = input as Record<string, unknown>
  if (
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    v['sha256'] !== expectedHash ||
    v['schema'] !== 1 ||
    v['event'] !== 'cef-binary-identity' ||
    v['source'] !== 'exported-api' ||
    v['sandbox'] !== 'unverified' ||
    typeof v['cefVersion'] !== 'string' ||
    !/^[1-9]\d*\.\d+\.\d+$/.test(v['cefVersion']) ||
    typeof v['chromiumVersion'] !== 'string' ||
    !/^[1-9]\d*\.\d+\.\d+\.\d+$/.test(v['chromiumVersion']) ||
    !Number.isSafeInteger(v['cefCommitNumber']) ||
    Number(v['cefCommitNumber']) < 0 ||
    (v['fullVersion'] !== null &&
      (typeof v['fullVersion'] !== 'string' || !/^[a-zA-Z0-9.+_-]{1,256}$/.test(v['fullVersion'])))
  )
    throw new Error('Invalid native CEF identity')
  return Object.freeze({
    event: 'cef-binary-identity',
    schema: 1,
    sha256: expectedHash,
    cefVersion: v['cefVersion'],
    chromiumVersion: v['chromiumVersion'],
    cefCommitNumber: Number(v['cefCommitNumber']),
    fullVersion: v['fullVersion'] as string | null,
    source: 'exported-api',
    sandbox: 'unverified',
  })
}
/** Native code stays in a disposable, observed helper, not the benchmark driver. */
export async function inspectCefLibrary(
  library: string,
  expectedHash: string,
  output: string,
  signal?: AbortSignal
): Promise<CefIdentity> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Expected native library SHA-256')
  const root = resolve(import.meta.dir, '../..')
  const report = await observedCommand(
    [
      process.env['PYTHON'] ?? 'python',
      resolve(root, 'scripts/probe_cef_identity.py'),
      '--library',
      resolve(library),
      '--sha256',
      expectedHash,
    ],
    { cwd: root, output, timeoutMs: 15000, ...(signal ? { signal } : {}) }
  ).result
  return cefIdentityFromObservation(report, expectedHash)
}
export function cefIdentityFromObservation(
  report: CommandObservation,
  expectedHash: string
): CefIdentity {
  assertCleanCommand(report)
  const identities: unknown[] = []
  for (const line of report.stdoutTail) {
    try {
      const value: unknown = JSON.parse(line)
      if (
        value &&
        typeof value === 'object' &&
        'event' in value &&
        value.event === 'cef-binary-identity'
      )
        identities.push(value)
    } catch {
      /* Native log lines do not identify a browser. */
    }
  }
  if (identities.length !== 1)
    throw new Error('Native helper did not return exactly one CEF identity')
  return parseCefIdentity(identities[0], expectedHash)
}

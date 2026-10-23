/**
 * Deterministic artifact selection per build profile, and the CEF-leakage scan.
 *
 * A profile decides what the built application may contain: the CEF profile
 * bundles a pinned CEF runtime, the system-webview profile must contain no CEF
 * payload at all and never downloads a runtime while the application runs.
 * Selection is deterministic - the same inventory always produces the same
 * selection and the same digest - so a build can be compared like for like.
 */
import { createHash } from 'node:crypto'
import { ArtifactError } from './manifest.ts'

/**
 * The shape this package needs from a build profile. The authoritative profile
 * metadata lives in the contracts package; this package stays free of it and
 * only states what selection needs.
 */
export interface ProfileArtifactPolicy {
  readonly bundledEngine: boolean
  readonly implicitRuntimeDownload: boolean
  readonly forbiddenEnginePayloads: readonly string[]
}

export interface ProfileSelectionPolicy {
  readonly id: string
  readonly artifactPolicy: ProfileArtifactPolicy
  readonly supportedPlatforms: readonly string[]
}

export type ProfileArtifactKind =
  | 'engine'
  | 'engine-helper'
  | 'engine-resource'
  | 'application'
  | 'runtime'

export interface ProfileArtifactCandidate {
  readonly path: string
  readonly size: number
  readonly kind: ProfileArtifactKind
  /** The engine a payload belongs to, when it is an engine payload. */
  readonly engine?: 'cef'
}

export interface SelectedProfileArtifact {
  readonly path: string
  readonly size: number
  readonly kind: ProfileArtifactKind
}

export interface ProfileSelection {
  readonly profile: string
  readonly target: string
  readonly files: readonly SelectedProfileArtifact[]
  readonly totalBytes: number
  /** A digest over the selection: the same inventory always yields the same value. */
  readonly inventoryDigest: string
}

export interface CefLeakageFinding {
  readonly path: string
  readonly kind: ProfileArtifactKind
  readonly reason: string
}

const CEF_LIBRARY_PATTERNS: readonly RegExp[] = [
  /(^|\/)libcef\./i,
  /(^|\/)chrome_elf/i,
  /(^|\/)libEGL\.so/i,
  /(^|\/)libGLESv2\.so/i,
  /(^|\/)vk_swiftshader/i,
  /(^|\/)(?:Chromium Embedded Framework|Chromium Framework|chrome)\.framework(?:\/|$)/i,
  /(^|\/)Chromium\.app/i,
]
const CEF_HELPER_PATTERNS: readonly RegExp[] = [
  /(^|\/)(?:[^/]+ )?Helper(?: App|(?: \([^/]+\))?\.app)(?:\/|$)/i,
  /(^|\/)cef_helper/i,
  /(^|\/)crashpad_handler/i,
]
const CEF_RESOURCE_PATTERNS: readonly RegExp[] = [
  /(^|\/)[^/]+\.pak$/i,
  /(^|\/)icudtl\.dat$/i,
  /(^|\/)snapshot_blob\.bin$/i,
  /(^|\/)v8_context_snapshot\.bin$/i,
  /(^|\/)vk_swiftshader_icd\.json$/i,
]

/**
 * CEF payloads in an inventory. The scan is name-based on purpose: it runs
 * against a file inventory before anything is downloaded or launched.
 */
export function scanCefLeakage(files: readonly ProfileArtifactCandidate[]): CefLeakageFinding[] {
  const findings: CefLeakageFinding[] = []
  for (const file of files) {
    const reason = CEF_LIBRARY_PATTERNS.some((pattern) => pattern.test(file.path))
      ? 'CEF library payload'
      : CEF_HELPER_PATTERNS.some((pattern) => pattern.test(file.path))
        ? 'CEF helper executable'
        : CEF_RESOURCE_PATTERNS.some((pattern) => pattern.test(file.path))
          ? 'CEF resource payload'
          : file.engine === 'cef' ||
              ['engine', 'engine-helper', 'engine-resource'].includes(file.kind)
            ? 'declared CEF engine payload'
            : undefined
    if (!reason) continue
    findings.push(Object.freeze({ path: file.path, kind: file.kind, reason }))
  }
  return findings.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )
}

export interface SelectProfileArtifactsInput {
  readonly profile: ProfileSelectionPolicy
  readonly target: string
  readonly files: readonly ProfileArtifactCandidate[]
  /** True when the build would fetch an engine while the application runs. */
  readonly implicitRuntimeDownload?: boolean
  /**
   * Whether the inventory must carry the profile's bundled engine. Default true: a
   * packaged application of a bundled-engine profile without its engine is incomplete.
   * The portable SDK bundle is not an application artifact and passes false.
   */
  readonly requireBundledEngine?: boolean
}

/**
 * Selects the artifacts of one profile. The selection fails loudly rather than
 * shipping a profile that does not match what it claims.
 */
export function selectProfileArtifacts(input: SelectProfileArtifactsInput): ProfileSelection {
  const { profile, target, files } = input
  if (!profile.supportedPlatforms.includes(target))
    throw new ArtifactError(
      'UNSUPPORTED_PLATFORM',
      `The ${profile.id} profile does not support ${target}`
    )
  if (profile.artifactPolicy.implicitRuntimeDownload || input.implicitRuntimeDownload === true)
    throw new ArtifactError(
      'IMPLICIT_RUNTIME_DOWNLOAD',
      `The ${profile.id} profile must not download a runtime at run time`
    )
  if (files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0))
    throw new ArtifactError('BAD_MANIFEST', 'Artifact sizes must be non-negative integers')

  const paths = new Set<string>()
  const kinds: readonly string[] = [
    'engine',
    'engine-helper',
    'engine-resource',
    'application',
    'runtime',
  ]
  for (const file of files) {
    if (
      typeof file.path !== 'string' ||
      !file.path ||
      // eslint-disable-next-line no-control-regex -- Inventory paths must reject control characters.
      /[\\\x00-\x1f:]/.test(file.path) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(file.path) ||
      !kinds.includes(file.kind)
    )
      throw new ArtifactError(
        'BAD_MANIFEST',
        'Artifact paths must be unique normalized relative paths with valid kinds'
      )
    paths.add(file.path)
  }

  const forbidden = profile.artifactPolicy.forbiddenEnginePayloads
  const leakage = forbidden.includes('cef') ? scanCefLeakage(files) : []
  if (leakage.length) {
    const paths = leakage.map((finding) => finding.path).join(', ')
    throw new ArtifactError(
      'FORBIDDEN_ENGINE_PAYLOAD',
      `The ${profile.id} profile must not contain CEF payloads: ${paths}`
    )
  }
  if (profile.artifactPolicy.bundledEngine && input.requireBundledEngine !== false) {
    const engineFiles = files.filter(
      (file) => file.kind === 'engine' || file.kind === 'engine-helper'
    )
    if (!engineFiles.length)
      throw new ArtifactError(
        'MISSING_ENGINE_PAYLOAD',
        `The ${profile.id} profile requires a bundled engine payload`
      )
  }

  const selected = files
    .map((file) => Object.freeze({ path: file.path, size: file.size, kind: file.kind }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const totalBytes = selected.reduce((sum, file) => sum + file.size, 0)
  if (!Number.isSafeInteger(totalBytes))
    throw new ArtifactError('BAD_MANIFEST', 'Total artifact size exceeds the safe integer limit')
  // Metadata identity only, not a hash of file bytes or a substitute for signed manifests.
  const digest = createHash('sha256').update(
    JSON.stringify({ profile: profile.id, target, files: selected })
  )
  return Object.freeze({
    profile: profile.id,
    target,
    files: Object.freeze(selected),
    totalBytes,
    inventoryDigest: `sha256:${digest.digest('hex')}`,
  })
}

/**
 * Explicit build profiles with versioned capability metadata.
 *
 * A profile is the build-time choice of browser backend. It separates what every
 * backend of that profile guarantees (portable guarantees) from what a single
 * backend adds (extensions), and it records the prerequisites a user must have
 * before the built application runs offline. Capability metadata is versioned so
 * a reader can tell which contract floor it was written against.
 */
import { BunlyError } from './core.ts'
import type { BackendName, Capability } from './core.ts'

/** The version of the capability metadata below. Bumped when the contract floor changes. */
export const PROFILE_CAPABILITY_VERSION = 2 as const

export type BuildProfileId = 'cef' | 'system-webview'
export type ProfilePlatform = 'darwin-arm64' | 'linux-x64' | 'win32-x64'

/**
 * How far an adapter is implemented. `not-implemented` is a first-class state:
 * an unfinished platform does not make another platform's profile inaccurate.
 */
export type ProfileAdapterStatus = 'implemented' | 'qualified' | 'not-implemented'

export interface ProfileCapabilityExtension {
  readonly backend: BackendName
  readonly capabilities: readonly Capability[]
  /** If present, this implementation extension exists only on the named targets. */
  readonly platforms?: readonly ProfilePlatform[]
}

export interface ProfileCapabilityMetadata {
  readonly version: typeof PROFILE_CAPABILITY_VERSION
  /** Capabilities every backend of the profile must provide. The contract floor. */
  readonly portable: readonly Capability[]
  /** Backend-specific capabilities. Never portable guarantees. */
  readonly extensions: readonly ProfileCapabilityExtension[]
}

export interface ProfilePrerequisite {
  readonly id: string
  readonly description: string
  readonly required: boolean
}

export interface ProfileArtifactPolicy {
  /** The profile ships a browser engine inside the artifact. */
  readonly bundledEngine: boolean
  /** The profile may fetch a runtime while the application runs. Always false. */
  readonly implicitRuntimeDownload: boolean
  /** Engine payloads that must not appear in this profile's artifacts. */
  readonly forbiddenEnginePayloads: readonly 'cef'[]
}

export interface ProfileAdapter {
  readonly backend: BackendName
  readonly platform: ProfilePlatform
  readonly status: ProfileAdapterStatus
  /** Why the adapter is not usable yet, or what qualification is still missing. */
  readonly note: string
}

export interface BuildProfile {
  readonly id: BuildProfileId
  readonly title: string
  readonly backends: readonly BackendName[]
  readonly capabilityMetadata: ProfileCapabilityMetadata
  readonly prerequisites: readonly ProfilePrerequisite[]
  readonly artifactPolicy: ProfileArtifactPolicy
  readonly supportedPlatforms: readonly ProfilePlatform[]
  readonly adapters: readonly ProfileAdapter[]
}

const LIFECYCLE_FLOOR = Object.freeze([
  'window.lifecycle',
  'view.navigate',
  'session.ephemeral',
] as const satisfies readonly Capability[])

export const BUILD_PROFILES: Readonly<Record<BuildProfileId, BuildProfile>> = Object.freeze({
  cef: Object.freeze({
    id: 'cef',
    title: 'Bundled CEF runtime',
    backends: Object.freeze(['cef'] as const),
    capabilityMetadata: Object.freeze({
      version: PROFILE_CAPABILITY_VERSION,
      portable: LIFECYCLE_FLOOR,
      extensions: Object.freeze([
        Object.freeze({
          backend: 'cef',
          capabilities: Object.freeze([
            'window.state',
            'window.geometry',
            'app.lifecycle',
            'view.composition',
            'download.manage',
            'session.persistent',
            'session.cookies',
            'session.protected-cookies',
            'session.cache',
            'session.flush',
          ] as const),
        }),
        Object.freeze({
          backend: 'cef',
          capabilities: Object.freeze(['clipboard.text'] as const),
          platforms: Object.freeze(['darwin-arm64', 'win32-x64'] as const),
        }),
      ] as const),
    }),
    prerequisites: Object.freeze([
      Object.freeze({
        id: 'cef-runtime',
        description:
          'The pinned CEF runtime payload recorded in the artifact manifest must be present in the installed application.',
        required: true,
      }),
    ]),
    artifactPolicy: Object.freeze({
      bundledEngine: true,
      implicitRuntimeDownload: false,
      forbiddenEnginePayloads: Object.freeze([] as const),
    }),
    supportedPlatforms: Object.freeze(['darwin-arm64', 'linux-x64', 'win32-x64'] as const),
    adapters: Object.freeze([
      Object.freeze({
        backend: 'cef',
        platform: 'darwin-arm64',
        status: 'implemented',
        note: 'The CEF backend and its native host exist in this tree; per-platform native qualification is tracked separately.',
      }),
      Object.freeze({
        backend: 'cef',
        platform: 'linux-x64',
        status: 'implemented',
        note: 'The CEF backend and its native host exist in this tree; per-platform native qualification is tracked separately.',
      }),
      Object.freeze({
        backend: 'cef',
        platform: 'win32-x64',
        status: 'implemented',
        note: 'The CEF backend and its native host exist in this tree; per-platform native qualification is tracked separately.',
      }),
    ]),
  }),
  'system-webview': Object.freeze({
    id: 'system-webview',
    title: 'Operating-system webview',
    backends: Object.freeze(['webview2', 'wkwebview', 'webkitgtk'] as const),
    capabilityMetadata: Object.freeze({
      version: PROFILE_CAPABILITY_VERSION,
      portable: LIFECYCLE_FLOOR,
      extensions: Object.freeze([] as const),
    }),
    prerequisites: Object.freeze([
      Object.freeze({
        id: 'system-webview',
        description:
          'The operating system webview engine (WebView2, WKWebView or WebKitGTK) must already be present. Bunly neither bundles nor downloads it.',
        required: true,
      }),
    ]),
    artifactPolicy: Object.freeze({
      bundledEngine: false,
      implicitRuntimeDownload: false,
      forbiddenEnginePayloads: Object.freeze(['cef'] as const),
    }),
    supportedPlatforms: Object.freeze(['darwin-arm64', 'linux-x64', 'win32-x64'] as const),
    adapters: Object.freeze([
      Object.freeze({
        backend: 'wkwebview',
        platform: 'darwin-arm64',
        status: 'not-implemented',
        note: 'The WKWebView adapter is not implemented in this tree (issue #49).',
      }),
      Object.freeze({
        backend: 'webview2',
        platform: 'win32-x64',
        status: 'not-implemented',
        note: 'The WebView2 adapter is not implemented in this tree (issue #50).',
      }),
      Object.freeze({
        backend: 'webkitgtk',
        platform: 'linux-x64',
        status: 'not-implemented',
        note: 'The WebKitGTK adapter is not implemented in this tree (issue #51).',
      }),
    ]),
  }),
})

export function profileFor(id: string): BuildProfile {
  const profile = Object.hasOwn(BUILD_PROFILES, id)
    ? BUILD_PROFILES[id as BuildProfileId]
    : undefined
  if (!profile) throw new BunlyError('INVALID_ARGUMENT', `Unknown build profile ${id}`)
  return profile
}

/** The profile a backend belongs to. The mock backend is a test double, not a profile. */
export function profileForBackend(name: BackendName): BuildProfile | undefined {
  return Object.values(BUILD_PROFILES).find((profile) => profile.backends.includes(name))
}

/**
 * The capability metadata of a profile as a backend sees it: the portable floor
 * plus that backend's extensions. A backend outside the profile has no metadata.
 */
export function capabilityMetadataFor(
  profile: BuildProfile,
  backend: BackendName
): ProfileCapabilityMetadata {
  if (!profile.backends.includes(backend))
    throw new BunlyError('INVALID_ARGUMENT', `${backend} is not part of the ${profile.id} profile`)
  const extensions = profile.capabilityMetadata.extensions.filter(
    (entry) => entry.backend === backend
  )
  return Object.freeze({
    version: profile.capabilityMetadata.version,
    portable: profile.capabilityMetadata.portable,
    extensions: Object.freeze(extensions.map((entry) => Object.freeze({ ...entry }))),
  })
}

/** Platform-scoped extensions require a matching target; they are never universal guarantees. */
export function profileProvidesCapability(
  profile: BuildProfile,
  backend: BackendName,
  capability: Capability,
  platform?: ProfilePlatform
): boolean {
  if (!profile.backends.includes(backend)) return false
  if (platform !== undefined && !profile.supportedPlatforms.includes(platform)) return false
  const metadata = capabilityMetadataFor(profile, backend)
  return (
    metadata.portable.includes(capability) ||
    metadata.extensions.some(
      (extension) =>
        extension.capabilities.includes(capability) &&
        (extension.platforms === undefined ||
          (platform !== undefined && extension.platforms.includes(platform)))
    )
  )
}

/**
 * The capability floor a backend of this profile must meet. A backend that does not
 * meet it is not qualified for the profile, and the shortfall is named instead of
 * being silently ignored.
 */
export function missingProfileCapabilities(
  profile: BuildProfile,
  backend: BackendName,
  provided: readonly Capability[]
): readonly Capability[] {
  if (!profile.backends.includes(backend))
    throw new BunlyError('INVALID_ARGUMENT', `${backend} is not part of the ${profile.id} profile`)
  return profile.capabilityMetadata.portable.filter((capability) => !provided.includes(capability))
}

/** The adapter record for one platform, if the profile has one. */
export function adapterFor(
  profile: BuildProfile,
  platform: ProfilePlatform
): ProfileAdapter | undefined {
  return profile.adapters.find((adapter) => adapter.platform === platform)
}

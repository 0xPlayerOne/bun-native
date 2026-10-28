import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILD_PROFILES,
  BunlyError,
  type BackendDescriptor,
  PROFILE_CAPABILITY_VERSION,
  adapterFor,
  capabilityMetadataFor,
  missingProfileCapabilities,
  profileFor,
  profileForBackend,
  profileProvidesCapability,
  requireCapability,
} from '../packages/contracts/src/index.ts'
import {
  MockBackend,
  runBackendConformance,
  summarizeConformance,
} from '../packages/runtime/src/index.ts'
import {
  ArtifactError,
  formatProfileResourceReport,
  reportProfileResources,
  scanCefLeakage,
  selectProfileArtifacts,
} from '../packages/artifacts/src/index.ts'
import type { ProfileArtifactCandidate } from '../packages/artifacts/src/index.ts'

const hasCode = (code: string) => (e: unknown) => e instanceof BunlyError && e.code === code
const hasArtifactCode = (code: string) => (e: unknown) =>
  e instanceof ArtifactError && e.code === code

const cefEngine: ProfileArtifactCandidate = {
  path: 'Frameworks/Chromium Framework.framework/Chromium Framework',
  size: 4096,
  kind: 'engine',
  engine: 'cef',
}
const cefHelper: ProfileArtifactCandidate = {
  path: 'Frameworks/Chromium Framework.framework/Helper Apps/Helper App',
  size: 512,
  kind: 'engine-helper',
  engine: 'cef',
}
const cefResource: ProfileArtifactCandidate = {
  path: 'Frameworks/Chromium Framework.framework/Resources/icudtl.dat',
  size: 1024,
  kind: 'engine-resource',
  engine: 'cef',
}
const appPayload: ProfileArtifactCandidate = {
  path: 'app/bunly.js',
  size: 256,
  kind: 'application',
}
const runtimePayload: ProfileArtifactCandidate = { path: 'bunly', size: 8192, kind: 'runtime' }

describe('explicit build profiles with versioned capability metadata', () => {
  it('declares both profiles with a versioned capability floor and documented prerequisites', () => {
    assert.deepEqual(Object.keys(BUILD_PROFILES).sort(), ['cef', 'system-webview'])
    for (const profile of Object.values(BUILD_PROFILES)) {
      assert.equal(profile.capabilityMetadata.version, PROFILE_CAPABILITY_VERSION)
      assert.ok(
        profile.capabilityMetadata.portable.length > 0,
        `${profile.id} has no portable guarantees`
      )
      assert.ok(profile.prerequisites.length > 0, `${profile.id} has no documented prerequisites`)
      assert.equal(profile.artifactPolicy.implicitRuntimeDownload, false)
      assert.ok(profile.supportedPlatforms.length > 0)
    }
    assert.deepEqual(profileFor('cef').backends, ['cef'])
    assert.deepEqual(profileFor('system-webview').backends, ['webview2', 'wkwebview', 'webkitgtk'])
    assert.equal(profileForBackend('cef')?.id, 'cef')
    assert.equal(profileForBackend('wkwebview')?.id, 'system-webview')
    assert.equal(profileForBackend('mock'), undefined)
    assert.throws(() => profileFor('nope'), hasCode('INVALID_ARGUMENT'))
  })

  it('separates portable guarantees from backend extensions', () => {
    const cef = profileFor('cef')
    const metadata = capabilityMetadataFor(cef, 'cef')
    assert.deepEqual(metadata.portable, cef.capabilityMetadata.portable)
    assert.deepEqual(metadata.extensions, [
      {
        backend: 'cef',
        capabilities: [
          'window.state',
          'window.geometry',
          'window.commands',
          'app.lifecycle',
          'view.composition',
          'download.manage',
          'session.persistent',
          'session.cookies',
          'session.protected-cookies',
          'session.cache',
          'session.flush',
        ],
      },
      {
        backend: 'cef',
        capabilities: ['clipboard.text'],
        platforms: ['darwin-arm64', 'win32-x64'],
      },
    ])
    assert.equal(profileProvidesCapability(cef, 'cef', 'window.lifecycle'), true)
    assert.equal(profileProvidesCapability(cef, 'cef', 'session.persistent'), true)
    assert.equal(profileProvidesCapability(cef, 'cef', 'view.snapshot'), false)
    assert.equal(profileProvidesCapability(cef, 'cef', 'clipboard.text'), false)
    assert.equal(profileProvidesCapability(cef, 'cef', 'clipboard.text', 'linux-x64'), false)
    assert.equal(profileProvidesCapability(cef, 'cef', 'clipboard.text', 'darwin-arm64'), true)
    assert.equal(profileProvidesCapability(cef, 'cef', 'clipboard.text', 'win32-x64'), true)
    assert.throws(() => capabilityMetadataFor(cef, 'wkwebview'), hasCode('INVALID_ARGUMENT'))
  })

  it('names the capabilities a backend is missing instead of silently accepting it', () => {
    const cef = profileFor('cef')
    assert.deepEqual(missingProfileCapabilities(cef, 'cef', ['window.lifecycle']), [
      'view.navigate',
      'session.ephemeral',
    ])
    assert.deepEqual(missingProfileCapabilities(cef, 'cef', cef.capabilityMetadata.portable), [])
  })

  it('qualifies adapters independently: one unfinished platform does not invalidate the profile', () => {
    const webview = profileFor('system-webview')
    const darwin = adapterFor(webview, 'darwin-arm64')
    const windows = adapterFor(webview, 'win32-x64')
    assert.equal(darwin?.backend, 'wkwebview')
    assert.equal(darwin?.status, 'not-implemented')
    assert.match(darwin?.note ?? '', /#49/)
    assert.equal(windows?.backend, 'webview2')
    assert.match(windows?.note ?? '', /#50/)
    // The profile itself stays usable: it declares its floor and its prerequisites.
    assert.ok(webview.capabilityMetadata.portable.length > 0)
    assert.equal(webview.artifactPolicy.bundledEngine, false)
    assert.deepEqual(webview.artifactPolicy.forbiddenEnginePayloads, ['cef'])
    const cef = profileFor('cef')
    assert.equal(adapterFor(cef, 'linux-x64')?.status, 'implemented')
  })

  it('refuses a backend whose capability metadata version does not match', () => {
    const backend = new MockBackend()
    const mismatched = { ...backend.descriptor, capabilityVersion: PROFILE_CAPABILITY_VERSION + 1 }
    assert.throws(() => requireCapability(mismatched, 'view.snapshot'), hasCode('VERSION_MISMATCH'))
    assert.throws(
      () => requireCapability(backend.descriptor, 'view.snapshot'),
      hasCode('UNSUPPORTED_CAPABILITY')
    )
  })
})

describe('deterministic artifact selection per profile', () => {
  it('selects deterministically regardless of inventory order', () => {
    const profile = profileFor('cef')
    const inventory = [appPayload, cefEngine, cefHelper, cefResource, runtimePayload]
    const first = selectProfileArtifacts({ profile, target: 'darwin-arm64', files: inventory })
    const second = selectProfileArtifacts({
      profile,
      target: 'darwin-arm64',
      files: [...inventory].reverse(),
    })
    assert.deepEqual(first.files, second.files)
    assert.equal(first.inventoryDigest, second.inventoryDigest)
    assert.equal(first.totalBytes, 4096 + 512 + 1024 + 256 + 8192)
    assert.deepEqual(
      first.files.map((file) => file.path),
      first.files.map((file) => file.path).sort()
    )
  })

  it('refuses a system-webview build that contains any CEF payload', () => {
    const profile = profileFor('system-webview')
    assert.throws(
      () =>
        selectProfileArtifacts({
          profile,
          target: 'darwin-arm64',
          files: [appPayload, runtimePayload, cefEngine],
        }),
      hasArtifactCode('FORBIDDEN_ENGINE_PAYLOAD')
    )
    const clean = selectProfileArtifacts({
      profile,
      target: 'darwin-arm64',
      files: [appPayload, runtimePayload],
    })
    assert.equal(clean.files.length, 2)
    assert.equal(clean.profile, 'system-webview')
  })

  it('refuses a CEF build without its bundled engine and any implicit runtime download', () => {
    const profile = profileFor('cef')
    assert.throws(
      () =>
        selectProfileArtifacts({
          profile,
          target: 'linux-x64',
          files: [appPayload, runtimePayload],
        }),
      hasArtifactCode('MISSING_ENGINE_PAYLOAD')
    )
    assert.throws(
      () =>
        selectProfileArtifacts({
          profile,
          target: 'linux-x64',
          files: [appPayload, cefEngine],
          implicitRuntimeDownload: true,
        }),
      hasArtifactCode('IMPLICIT_RUNTIME_DOWNLOAD')
    )
    // The portable SDK bundle is not an application artifact, so it opts out of the
    // bundled-engine requirement while the CEF-leakage rule still applies.
    const bundle = selectProfileArtifacts({
      profile,
      target: 'linux-x64',
      files: [appPayload, runtimePayload],
      requireBundledEngine: false,
    })
    assert.equal(bundle.files.length, 2)
  })

  it('scans an inventory for CEF libraries, helpers and resources', () => {
    const findings = scanCefLeakage([
      { path: 'lib/libcef.so', size: 1, kind: 'engine' },
      { path: 'bin/Helper App', size: 1, kind: 'engine-helper' },
      { path: 'resources/en-US.pak', size: 1, kind: 'engine-resource' },
      appPayload,
    ])
    assert.deepEqual(
      findings.map((finding) => finding.path),
      ['bin/Helper App', 'lib/libcef.so', 'resources/en-US.pak']
    )
    assert.ok(findings.every((finding) => finding.reason.length > 0))
    assert.deepEqual(scanCefLeakage([appPayload, runtimePayload]), [])
  })
})

describe('shared backend contract suite', () => {
  it('measures the mock backend against the portable semantics', async () => {
    const backend = new MockBackend()
    const report = await runBackendConformance(backend)
    await backend.dispose()
    assert.equal(report.failed, 0, summarizeConformance(report))
    assert.equal(report.skipped, 0)
    assert.ok(report.passed >= 10)
    assert.equal(report.backend, 'mock')
    assert.equal(report.capabilityVersion, PROFILE_CAPABILITY_VERSION)
    const areas = new Set(report.checks.map((check) => check.area))
    for (const area of [
      'resource-ownership',
      'rpc-authority',
      'navigation',
      'profiles',
      'permissions',
      'supported-actions',
      'reload',
    ])
      assert.ok(areas.has(area as never), `missing area ${area}`)
    for (const check of report.checks)
      assert.equal(check.status, 'pass', `${check.name}: ${check.detail ?? ''}`)
  })

  it('reports a check the backend cannot answer as skipped with its reason, never as a pass', async () => {
    const backend = new MockBackend()
    const report = await runBackendConformance(backend)
    await backend.dispose()
    for (const check of report.checks) {
      if (check.status === 'skipped') assert.ok(check.detail && check.detail.length > 0)
      else assert.equal(check.detail, undefined)
    }
    // The mock implements no snapshot, so the unsupported path is exercised instead:
    // the action must fail clearly rather than silently succeed.
    const unsupportedAction = report.checks.find(
      (check) => check.name === 'an unsupported action fails instead of silently succeeding'
    )
    assert.equal(unsupportedAction?.status, 'pass')
    assert.equal(report.skipped, 0)
    assert.equal(report.failed, 0)
  })

  it('skips a check it cannot exercise when the backend does implement the capability', async () => {
    // A backend that implements the capability cannot show the unsupported path, so that
    // check is skipped with its reason and the supported path is measured instead.
    const mockDescriptor = new MockBackend().descriptor
    class SnapshotBackend extends MockBackend {
      override readonly descriptor: BackendDescriptor = Object.freeze({
        ...mockDescriptor,
        capabilities: Object.freeze([...mockDescriptor.capabilities, 'view.snapshot'] as const),
      })
      override async snapshot(): Promise<Uint8Array> {
        return new Uint8Array([1, 2, 3])
      }
    }
    const backend = new SnapshotBackend()
    const report = await runBackendConformance(backend)
    await backend.dispose()
    assert.equal(report.failed, 0, summarizeConformance(report))
    assert.equal(report.skipped, 1)
    const skipped = report.checks.filter((check) => check.status === 'skipped')
    assert.match(skipped[0]?.detail ?? '', /view\.snapshot/)
    const supported = report.checks.find(
      (check) => check.name === 'a supported action returns its documented shape'
    )
    assert.equal(supported?.status, 'pass')
  })
})

describe('per-profile resource reporting', () => {
  it('separates measured figures from figures that were not measured', () => {
    const report = reportProfileResources('system-webview', {
      installerBytes: 1024,
      installedBytes: 2048,
      externalRuntimeDownloads: 0,
      notMeasuredReasons: {
        cacheBytes: 'the profile has no run-time cache on this platform',
        residentMemoryBytes: 'no native launch was performed',
      },
    })
    assert.equal(report.installerBytes.bytes, 1024)
    assert.equal(report.installerBytes.source, 'measured')
    assert.equal(report.externalRuntimeDownloads.bytes, 0)
    assert.equal(report.externalRuntimeDownloads.source, 'measured')
    assert.equal(report.cacheBytes.bytes, null)
    assert.equal(report.cacheBytes.source, 'not-measured')
    assert.match(report.cacheBytes.reason ?? '', /cache/)
    assert.equal(report.residentMemoryBytes.source, 'not-measured')
    assert.equal(report.complete, false)
    const rendered = formatProfileResourceReport(report)
    assert.match(rendered, /system-webview/)
    assert.match(rendered, /cacheBytes=not-measured/)
  })

  it('never reports an absent measurement as zero', () => {
    const report = reportProfileResources('cef')
    assert.equal(report.complete, false)
    for (const key of [
      'installerBytes',
      'installedBytes',
      'cacheBytes',
      'residentMemoryBytes',
    ] as const) {
      assert.equal(report[key].bytes, null, `${key} must not be reported as a number`)
      assert.equal(report[key].source, 'not-measured')
    }
  })
})

describe('profile selection rejects misleading inventories', () => {
  it('detects known CEF payload names even when mislabeled as application or runtime files', () => {
    for (const path of [
      'lib/libcef.so',
      'libcef.dll',
      'Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework',
      'Frameworks/Bunly Helper (Renderer).app/Contents/MacOS/Bunly Helper (Renderer)',
      'resources/icudtl.dat',
      'resources/en-US.pak',
    ]) {
      for (const kind of ['application', 'runtime'] as const) {
        assert.throws(
          () =>
            selectProfileArtifacts({
              profile: profileFor('system-webview'),
              target: 'darwin-arm64',
              files: [{ path, size: 1, kind }],
            }),
          hasArtifactCode('FORBIDDEN_ENGINE_PAYLOAD'),
          path
        )
      }
    }
  })

  it('rejects duplicate, ambiguous and escaping paths and overflowing totals', () => {
    const select = (files: readonly ProfileArtifactCandidate[]) =>
      selectProfileArtifacts({
        profile: profileFor('system-webview'),
        target: 'darwin-arm64',
        files,
      })
    assert.throws(() => select([appPayload, appPayload]), hasArtifactCode('BAD_MANIFEST'))
    for (const path of ['', '/absolute', '../escape', 'a/../b', 'a//b', 'a\\b', 'a\nnext'])
      assert.throws(() => select([{ ...appPayload, path }]), hasArtifactCode('BAD_MANIFEST'))
    assert.throws(
      () => select([{ ...appPayload, size: Number.MAX_SAFE_INTEGER }, runtimePayload]),
      hasArtifactCode('BAD_MANIFEST')
    )
  })

  it('binds inventory identity to its actual profile and platform', () => {
    const input = { profile: profileFor('cef'), target: 'darwin-arm64', files: [cefEngine] }
    const first = selectProfileArtifacts(input)
    assert.notEqual(
      first.inventoryDigest,
      selectProfileArtifacts({ ...input, target: 'linux-x64' }).inventoryDigest
    )
    assert.throws(
      () => selectProfileArtifacts({ ...input, target: 'unsupported' }),
      hasArtifactCode('UNSUPPORTED_PLATFORM')
    )
  })
})

describe('conformance resource cleanup', () => {
  it('returns resources and listeners to baseline across repeated runs', async () => {
    const backend = new MockBackend()
    const baseline = backend.diagnostics()
    for (let i = 0; i < 3; i++) {
      assert.equal((await runBackendConformance(backend)).failed, 0)
      assert.deepEqual(backend.diagnostics(), baseline)
    }
    await backend.dispose()
  })

  it('releases owned resources when setup or navigation fails', async () => {
    class FailingWindow extends MockBackend {
      override async createWindow(): Promise<never> {
        throw new Error('window failed')
      }
    }
    class FailingNavigation extends MockBackend {
      override async navigate(): Promise<never> {
        throw new Error('navigation failed')
      }
    }
    for (const backend of [new FailingWindow(), new FailingNavigation()]) {
      const baseline = backend.diagnostics()
      await assert.rejects(runBackendConformance(backend), /failed/)
      assert.deepEqual(backend.diagnostics(), baseline)
      await backend.dispose()
    }
  })
})

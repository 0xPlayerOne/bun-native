import { DESKTOP_OBSERVER_MS, DESKTOP_PROFILE } from '../../benchmarks/desktop/acceptance.ts'

/** Synthetic parser inputs only; never exported as native qualification evidence. */
export function desktopReportFixture(options: {
  receipt: unknown
  acceptance: unknown
  profile?: string
  target?: string
  sourcePaths?: readonly string[]
}): Record<string, unknown> {
  const { target = 'linux-x64' } = options
  const mac = target === 'darwin-arm64'
  const windows = target === 'win32-x64'
  const hostPath = mac ? 'Contents/MacOS/bunly_host' : windows ? 'bunly_host.exe' : 'bunly_host'
  const libraryPath = mac
    ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
    : windows
      ? 'libcef.dll'
      : 'libcef.so'
  const resources = mac ? 'Contents/Resources' : 'resources'
  const bunPath = resources + (windows ? '/bun.exe' : '/bun')
  const entries = [
    hostPath,
    libraryPath,
    bunPath,
    resources + '/runtime.json',
    resources + '/backend/main.js',
    resources + '/backend/application.js',
    resources + '/public/client.js',
    ...(windows ? ['bunly_host.dll'] : []),
  ].map((path, i) => ({ path, kind: 'file', bytes: i + 1, sha256: String(i).repeat(64) }))
  const artifact = {
    schema: 1,
    metric: 'logical-installed-file-bytes-no-symlink-traversal',
    bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    entries,
    duplicateContent: [],
  }
  const metadata = entries.map((entry, i) => ({
    path: entry.path,
    size: String(entry.bytes),
    mtimeNs: '100',
    ctimeNs: '100',
    device: '1',
    inode: String(i + 1),
    mode: '33216',
    uid: '1000',
    gid: '1000',
    links: '1',
  }))
  const observation = {
    schema: 1,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    cleanupSurvivors: [],
    outputOverflow: false,
    observedOrphans: [],
    elapsedMs: 1000,
    peakTreeRssBytes: 1,
    peakTreeThreads: 1,
    stdoutTail: [] as string[],
    samples: [],
    environment: {
      os: mac ? 'Darwin' : windows ? 'Windows' : 'Linux',
      arch: mac ? 'arm64' : 'x86_64',
      runClass: 'local-smoke',
    },
    stderr: [
      JSON.stringify(options.receipt),
      JSON.stringify({ event: 'bunly.host.shutdown-phase', phase: 'process-stop', state: 'start' }),
      JSON.stringify({ event: 'bunly.backend.exit', code: 0, forced: false }),
      JSON.stringify({
        event: 'bunly.native.output-drained',
        schema: 1,
        frames: 0,
        ordinaryFrames: 0,
        retainedWireBytes: 0,
        ordinaryWireBytes: 0,
      }),
      JSON.stringify({
        event: 'bunly.host.shutdown-phase',
        phase: 'process-stop',
        state: 'complete',
        durationMs: 1,
      }),
      ...['host-release', 'asset-service-stop', 'cef-shutdown'].flatMap((phase) => [
        JSON.stringify({ event: 'bunly.host.shutdown-phase', phase, state: 'start' }),
        JSON.stringify({
          event: 'bunly.host.shutdown-phase',
          phase,
          state: 'complete',
          durationMs: 1,
        }),
      ]),
      JSON.stringify({ event: 'bunly.host.shutdown', clean: true }),
    ],
  }
  const source = { clean: true, reason: 'clean-checkout', commit: 'a'.repeat(40) }
  const hashes = [
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'tsconfig.browser.json',
    'packages/contracts/src/windows.ts',
    'packages/runtime/src/cef.ts',
    'packages/runtime/src/native-transport.ts',
    'examples/desktop-controls/fixture.ts',
    'examples/desktop-controls/client.ts',
    'examples/desktop-controls/contract.ts',
    'benchmarks/desktop/acceptance.ts',
    'benchmarks/reload/prepared-file-metadata.ts',
    'benchmarks/lib/observed-command.ts',
    'benchmarks/lib/cef-identity.ts',
    'benchmarks/lib/inventory.ts',
    'scripts/qualify-desktop.ts',
    'scripts/observe-process.py',
    'native/cef-host/src/window_state.rs',
    'native/cef-host/src/process.rs',
    'native/cef-host/src/host.rs',
    ...(options.sourcePaths ?? []),
  ].map((path) => ({ path, sha256: 'b'.repeat(64) }))
  const identity = {
    event: 'cef-binary-identity',
    schema: 1,
    source: 'exported-api',
    sandbox: 'unverified',
    cefVersion: '156.0.7',
    chromiumVersion: '156.0.8078.17',
    cefCommitNumber: 1,
    fullVersion: null,
    sha256: entries[1]!.sha256,
  }
  return {
    schema: 1,
    profile: options.profile ?? DESKTOP_PROFILE,
    passed: true,
    performanceEligible: false,
    target,
    bun: '1.4.4',
    observerTimeoutMs: DESKTOP_OBSERVER_MS,
    sourceBefore: source,
    sourceAfter: structuredClone(source),
    sourceHashes: hashes,
    sourceHashesAfter: structuredClone(hashes),
    nativeSource: {
      declaredCommit: source.commit,
      tree: 'c'.repeat(40),
      embeddedBuildAttestation: false,
    },
    inputArtifact: artifact,
    inputArtifactAfter: structuredClone(artifact),
    preparedArtifact: structuredClone(artifact),
    preparedArtifactAfter: structuredClone(artifact),
    inputArtifactUnchanged: true,
    preparedArtifactUnchanged: true,
    hostPath,
    inputHostSha256: entries[0]!.sha256,
    preparedHostSha256: entries[0]!.sha256,
    preparedMetadataBefore: metadata,
    preparedMetadataAfter: structuredClone(metadata),
    preparedMetadata: { identityUnchanged: true, ctimeChangedPaths: [], ctimeChangeReason: 'none' },
    runtimeIdentity: identity,
    identityObservation: { ...observation, stdoutTail: [JSON.stringify(identity)], stderr: [] },
    bundledBun: {
      version: '1.4.4',
      path: bunPath,
      sha256: entries[2]!.sha256,
      observation: { ...observation, stdoutTail: ['1.4.4'], stderr: [] },
    },
    observation,
    acceptance: options.acceptance,
  }
}

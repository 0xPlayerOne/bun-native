/** Actual CEF paired transport profiling, with all failures retained. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import {
  observedCommand,
  assertCleanCommand,
  type CommandObservation,
} from '../benchmarks/lib/observed-command.ts'
import {
  acceptNativeTransport,
  idleKernelObservation,
} from '../benchmarks/lib/cef-transport-acceptance.ts'
import {
  RPC_TRANSPORT_WORKLOAD,
  assertComparable,
  type RpcTransportTrial,
} from '../benchmarks/rpc-transport-comparison.ts'
import { distribution, profileOptions } from '../benchmarks/foundation/statistics.ts'

const root = resolve(import.meta.dir, '..'),
  args = process.argv.slice(2),
  input = args.shift()
if (!input || Bun.version !== '1.4.3')
  throw new Error(
    'Use Bun 1.4.3: qualify-cef-transports PREPARED_APP [--native-only] [--functional | --samples 5..100 --warmups 0..10]'
  )
const nativeOnly = args.includes('--native-only')
if (nativeOnly) args.splice(args.indexOf('--native-only'), 1)
const candidates = nativeOnly
  ? (['native-mediated'] as const)
  : (['native-mediated', 'authenticated-loopback'] as const)
const functional = args.length === 1 && args[0] === '--functional'
const options = functional ? { samples: 1, warmups: 0, output: '' } : profileOptions(args, '')
if (!functional && options.output)
  throw new Error('Qualification writes an exclusively owned run directory; no output override')
const mac = process.platform === 'darwin',
  source = resolve(input),
  inputRoot = mac ? source : dirname(source)
const original = await inventory(inputRoot)
const parent = join(root, '.bunly/m3/transports')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const paths = [
  'scripts/qualify-cef-transports.ts',
  'packages/runtime/src/native-transport.ts',
  'packages/runtime/src/native-capacity.json',
  'native/cef-host/src/command_budget.rs',
  'native/cef-host/src/process.rs',
  'examples/cef/transport.ts',
  'examples/cef/transport-client.ts',
  'examples/cef/transport-contract.ts',
  'packages/client/src/cef-rpc.ts',
  'packages/client/src/cef-loopback.ts',
  'packages/client/src/rpc-loopback.ts',
  'packages/runtime/src/cef.ts',
  'packages/runtime/src/rpc-loopback.ts',
  'packages/contracts/src/rpc-native-handoff.ts',
  'packages/contracts/src/rpc-fragments.ts',
  'packages/contracts/src/rpc-websocket-wire.ts',
  'native/cef-host/src/host.rs',
  'native/cef-host/src/process.rs',
  'native/cef-host/src/event_queue.rs',
  'native/cef-host/src/exit_notification.rs',
  'native/cef-host/src/resources.rs',
  'native/cef-host/src/rpc_transport_qualification.rs',
  'benchmarks/lib/cef-transport-acceptance.ts',
  'benchmarks/lib/cef-acceptance.ts',
  'benchmarks/lib/observed-command.ts',
  'benchmarks/lib/native-diagnostic-events.json',
  'benchmarks/foundation/native-shutdown.ts',
  'native/cef-host/src/network_policy.rs',
  'benchmarks/rpc-transport-comparison.ts',
  'scripts/observe-process.py',
  'scripts/kernel_counters.py',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ])
    )
  )
const before = sourceIdentity(root)
const attempts: Record<string, unknown>[] = []
const trials: RpcTransportTrial[] = []
const report: Record<string, unknown> = {
  schema: 1,
  classification: functional
    ? 'native-transport-functional-qualification'
    : nativeOnly
      ? 'single-native-rpc-transport-profile'
      : 'paired-native-rpc-transport',
  passed: false,
  comparable: false,
  winner: null,
  target: `${process.platform}-${process.arch}`,
  sourceBefore: before,
  sourceHashes: await fingerprints(),
  inputArtifact: original,
  requestedCandidates: candidates,
  workload: RPC_TRANSPORT_WORKLOAD,
  samples: options.samples,
  warmups: options.warmups,
  attempts,
  trials,
  limits: [
    'One admitted control waiter remains during both two-second idle samples; no polling or application payload workload.',
    'Kernel measurements use qualified provider semantics and adjacent matched identities only; gaps remain unavailable, not zero.',
    'CPU throttling is the actual fixed Chromium CDP method with verified native completion, not a claim of physical CPU/hardware input equivalence.',
    'Functional/hosted observations are not quiet-machine performance or production release qualification.',
    'Loopback uses contributor-only top-origin reachability in a local-only ephemeral fixture; native socket-owner authentication remains separate. No shipping permission support is implied.',
    'Historical intermittent native shutdown failures are not erased by passing launches.',
  ],
  copyAccounting: {
    zeroCopyClaim: false,
    knownStages: {
      'native-mediated': [
        'RPC packet encoding',
        'bounded writer snapshot',
        '96 KiB bounded fragment reassembly',
        '24 KiB native adapter snapshot',
        'hex encoding in private control pipe',
        'CEF binary copy',
        'renderer ArrayBuffer copy',
        'RPC payload decode',
      ],
      'authenticated-loopback': [
        'RPC packet encoding',
        'bounded writer snapshot',
        'WebSocket binary record allocation',
        'WebSocket receive payload isolation',
        'RPC payload decode',
        'one-time native offer and socket challenge',
      ],
    },
    unknownStages: [
      'CEF internal process-message serialization',
      'Bun WebSocket and browser implementation buffering',
      'OS pipe/socket/kernel copies',
    ],
  },
}
const python = process.env['PYTHON'] ?? 'python3'
try {
  if (!functional)
    assert.equal(before.clean, true, 'Paired profiling requires clean committed source')
  const app = join(work, mac ? 'Transports.app' : 'Transport Unicode é Ω')
  await cp(inputRoot, app, { recursive: true, dereference: false })
  const resources = join(app, mac ? 'Contents/Resources' : 'resources')
  const runtime = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8'))
  assert.equal(runtime.development_origin, undefined)
  const built = await Bun.build({
    entrypoints: [join(root, 'examples/cef/transport.ts')],
    outdir: join(resources, 'backend'),
    naming: 'application.js',
    target: 'bun',
  })
  assert.equal(built.success, true, String(built.logs))
  if (mac) {
    const script = join(work, 'sign.py')
    await writeFile(
      script,
      [
        'import sys,subprocess',
        'from pathlib import Path',
        `sys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})`,
        'from qualify_adhoc_signing import targets',
        `for p in targets(Path(${JSON.stringify(app)})): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)`,
        '',
      ].join('\n')
    )
    assertCleanCommand(
      await observedCommand([python, script], {
        cwd: root,
        output: join(work, 'sign.process.json'),
        timeoutMs: 30000,
      }).result
    )
  }
  const prepared = await inventory(app)
  report['preparedArtifact'] = prepared
  const library = join(
    app,
    mac
      ? 'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'
      : process.platform === 'win32'
        ? 'libcef.dll'
        : 'libcef.so'
  )
  const libraryHash = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(library).arrayBuffer())
    .digest('hex')
  const identity = await observedCommand(
    [
      python,
      join(root, 'scripts/probe_cef_identity.py'),
      '--library',
      library,
      '--sha256',
      libraryHash,
    ],
    { cwd: work, output: join(work, 'identity.process.json'), timeoutMs: 30000 }
  ).result
  assertCleanCommand(identity)
  const identityLine = identity.stdoutTail.find((line) => line.startsWith('{'))
  assert.ok(identityLine)
  report['runtimeIdentity'] = JSON.parse(identityLine)
  const executable = mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(source))
  for (let index = -options.warmups; index < options.samples; index++) {
    const order = index % 2 === 0 ? candidates : [...candidates].reverse()
    for (const candidate of order) {
      const name = candidate + '-' + index
      const observation = await observedCommand([executable], {
        cwd: work,
        output: join(work, name + '.process.json'),
        timeoutMs: 30000,
        env: {
          BUNLY_CACHE_DIR: join(work, name + '-cache'),
          BUNLY_RPC_TRANSPORT: candidate,
          BUNLY_KERNEL_COUNTERS: '1',
          BUNLY_BENCH_SANDBOX: '1',
        },
      }).result
      const attempt: Record<string, unknown> = {
        candidate,
        index,
        warmup: index < 0,
        passed: false,
        observation,
      }
      attempts.push(attempt)
      const accepted = acceptNativeTransport(observation, candidate, index)
      attempt['metrics'] = accepted
      const raw = observation as CommandObservation & { kernelMeasurements?: unknown }
      attempt['idleWakeups'] = idleKernelObservation(raw.kernelMeasurements)
      attempt.passed = true
      if (index >= 0) trials.push(accepted)
      console.log(JSON.stringify({ candidate, index, warmup: index < 0, passed: true }))
    }
  }
  if (!functional && !nativeOnly) {
    assertComparable(trials)
    report['comparable'] = true
  }
  report['distributions'] = Object.fromEntries(
    candidates.map((candidate) => {
      const rows = trials.filter((trial) => trial.candidate === candidate)
      return [
        candidate,
        Object.fromEntries(
          (['handoffMs', 'structuredMs', 'binaryMs', 'cancellationMs'] as const).map((metric) => [
            metric,
            distribution(rows.map((row) => row[metric])),
          ])
        ),
      ]
    })
  )
  assert.deepEqual(await inventory(app), prepared, 'Prepared artifact changed during comparison')
  assert.deepEqual(await inventory(inputRoot), original, 'Input artifact changed during comparison')
  report['preparedArtifactUnchanged'] = true
  report['inputArtifactUnchanged'] = true
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  const after = sourceIdentity(root)
  report['sourceAfter'] = after
  if (!functional && (!after.clean || after.commit !== before.commit)) {
    report.passed = false
    report['failure'] = 'Committed source changed during comparison'
  }
  report['sourceHashesAfter'] = await fingerprints()
  if (JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])) {
    report.passed = false
    report['failure'] = 'Harness changed during comparison'
  }
  const output = join(work, 'report.json')
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(
    JSON.stringify({
      passed: report.passed,
      comparable: report['comparable'],
      output,
      failure: report['failure'],
    })
  )
}
if (!report.passed) process.exitCode = 1

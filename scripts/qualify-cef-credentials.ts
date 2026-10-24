/** Actual OS-provider qualification, exclusively on disposable hosted runners. */
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { observedCommand, type CommandObservation } from '../benchmarks/lib/observed-command.ts'
import { acceptNativeRejection } from '../benchmarks/lib/cef-acceptance.ts'
import {
  acceptNativeCredentials,
  type CredentialMode,
} from '../benchmarks/lib/cef-credential-acceptance.ts'

if (
  process.env['GITHUB_ACTIONS'] !== 'true' ||
  process.env['RUNNER_ENVIRONMENT'] !== 'github-hosted'
)
  throw new Error(
    'Credential-provider qualification is restricted to disposable GitHub-hosted runners'
  )
if (Bun.version !== '1.4.3' || process.argv.length !== 3)
  throw new Error('Use pinned Bun: qualify-cef-credentials PREPARED_APP')
const root = resolve(import.meta.dir, '..')
assert.equal(await realpath(process.env['GITHUB_WORKSPACE'] ?? ''), await realpath(root))
if (process.getuid?.() === 0)
  throw new Error('Credential qualification requires an unprivileged user')
const python = process.env['PYTHON'] ?? 'python'
if (process.platform === 'win32') {
  const check = Bun.spawnSync([
    python,
    '-c',
    'import ctypes; raise SystemExit(1 if ctypes.windll.shell32.IsUserAnAdmin() else 0)',
  ])
  assert.equal(
    check.exitCode,
    0,
    'Windows credential qualification requires the standard-user worker'
  )
}
const providers: Record<string, string> = {
  darwin: 'macos-keychain',
  linux: 'linux-secret-service',
  win32: 'windows-dpapi',
}
const provider = providers[process.platform]
assert.ok(provider)
const mac = process.platform === 'darwin',
  source = resolve(process.argv[2]!),
  inputRoot = mac ? source : dirname(source)
const original = await inventory(inputRoot)
const parent = join(root, '.bunly/m3/credentials')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
const app = join(work, mac ? 'Credential.app' : 'Credential Native')
// Match the explicit Windows storage-path budget without global OS changes.
const profileWork = process.platform === 'win32' ? await mkdtemp(join(root, '.bunly/c-')) : work
const profileRoot = join(profileWork, 'p')
const applicationId = 'dev.bunly.credentialfixture.r' + randomBytes(6).toString('hex')
const sourceBefore = sourceIdentity(root)
assert.equal(sourceBefore.clean, true, 'OS-provider acceptance requires committed clean source')
const trials: Record<string, unknown>[] = []
const successes: CommandObservation[] = []
const report: Record<string, unknown> = {
  schema: 1,
  classification: 'native-credential-provider-qualification',
  target: `${process.platform}-${process.arch}`,
  provider,
  passed: false,
  sourceBefore,
  trials,
  limits: [
    'Disposable synthetic cookies and OS keys only; no production account or personal keychain.',
    'Windows DPAPI is user-bound, not Chrome app-bound service encryption.',
    'Linux Secret Service uses an explicitly acknowledged Chromium-user-shared key.',
    'Cookie protection does not encrypt all HTML5 origin storage or establish release qualification.',
  ],
}
const files = [
  'scripts/qualify-cef-credentials.ts',
  'packages/runtime/src/native-transport.ts',
  'packages/runtime/src/native-capacity.json',
  'native/cef-host/src/command_budget.rs',
  'native/cef-host/src/process.rs',
  'examples/cef/credentials.ts',
  'examples/cef/credentials-client.ts',
  'packages/runtime/src/credential-proof.ts',
  'packages/runtime/src/cef.ts',
  'native/cef-host/src/credential_callbacks.rs',
  'native/cef-host/src/cookie_completion.rs',
  'native/cef-host/src/session_reset.rs',
  'native/cef-host/src/session_credentials.rs',
  'native/cef-host/src/host.rs',
  'native/cef-host/src/lib.rs',
  'benchmarks/lib/cef-credential-acceptance.ts',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(join(root, file)))
          .digest('hex'),
      ])
    )
  )
report['sourceHashes'] = await fingerprints()
const executable = (path: string) =>
  mac ? join(path, 'Contents/MacOS/bunly_host') : join(path, basename(source))
const resources = (path: string) => join(path, mac ? 'Contents/Resources' : 'resources')
let server: Bun.Server<undefined> | undefined
let originalKeychains: string[] | undefined,
  keychainCreated = false,
  searchChanged = false
const keychain = join(work, 'qualification.keychain-db')
let keyring: Bun.Subprocess | undefined
let prepared: Awaited<ReturnType<typeof inventory>> | undefined
const providerEnv: Record<string, string> = {}

async function bounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > 64 * 1024) throw new Error('Provider setup output exceeded its bound')
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
// Never print provider-tool arguments or errors: setup arguments include only
// disposable secrets, but they must still stay out of Actions logs/artifacts.
async function tool(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...providerEnv },
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  if (input !== undefined) child.stdin.write(input)
  child.stdin.end()
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      bounded(child.stdout),
      bounded(child.stderr),
    ])
    if (code !== 0) throw new Error('Disposable credential-provider setup/cleanup command failed')
    return stdout
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
  }
}
async function sign(path: string) {
  if (!mac) return
  const file = join(work, 'sign-' + randomBytes(6).toString('hex') + '.py')
  await writeFile(
    file,
    `import sys,subprocess\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})\nfrom qualify_adhoc_signing import targets\nfor p in targets(Path(${JSON.stringify(path)})): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)\n`,
    { mode: 0o600 }
  )
  await tool([python, file])
}
const common = (mode: string, changes: Record<string, string> = {}) => ({
  ...providerEnv,
  BUNLY_PROFILE_ROOT: profileRoot,
  BUNLY_CREDENTIAL_MODE: mode,
  BUNLY_CREDENTIAL_ORIGIN: server!.url.origin,
  BUNLY_CACHE_DIR: join(work, 'cache-' + mode),
  ...changes,
})
async function launch(
  mode: CredentialMode,
  changes: Record<string, string> = {},
  trialName: string = mode
) {
  const observation = await observedCommand([executable(app)], {
    cwd: work,
    output: join(work, trialName + '.process.json'),
    timeoutMs: 30000,
    env: common(mode, changes),
  }).result
  const trial = { name: trialName, passed: false, observation }
  trials.push(trial)
  acceptNativeCredentials(observation, mode)
  trial.passed = true
  successes.push(observation)
  console.log(JSON.stringify({ mode, passed: true }))
}
try {
  const client = await Bun.build({
    entrypoints: [join(root, 'examples/cef/credentials-client.ts')],
    target: 'browser',
    format: 'esm',
  })
  assert.ok(client.success)
  const js = await client.outputs[0]!.text()
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/client.js')
        return new Response(js, { headers: { 'content-type': 'text/javascript' } })
      if (url.pathname === '/probe') {
        const partition = url.searchParams.get('partition'),
          expected = url.searchParams.get('expected')
        const cookies = request.headers.get('cookie') ?? ''
        const passed =
          ['A', 'B', 'E'].includes(String(partition)) &&
          (expected === 'present'
            ? cookies === `bunly_credential_fixture=${partition}`
            : expected === 'empty' && cookies === '')
        return Response.json({ passed })
      }
      return new Response(
        '<!doctype html><title>Credential fixture</title><script type="module" src="/client.js"></script>',
        {
          headers: {
            'content-type': 'text/html',
            'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'",
          },
        }
      )
    },
  })
  await cp(inputRoot, app, { recursive: true, dereference: false })
  const config = JSON.parse(await readFile(join(resources(app), 'runtime.json'), 'utf8')) as Record<
    string,
    unknown
  >
  assert.equal(config['cef_version'], '156.0.7')
  assert.equal(config['development_origin'], undefined)
  config['development_origin'] = server.url.origin
  config['credential_policy'] = {
    applicationId,
    provider,
    ...(provider === 'linux-secret-service' ? { sharedKeyScope: 'chromium-user-shared' } : {}),
  }
  await writeFile(join(resources(app), 'runtime.json'), JSON.stringify(config))
  const built = await Bun.build({
    entrypoints: [join(root, 'examples/cef/credentials.ts')],
    target: 'bun',
    outdir: join(resources(app), 'backend'),
    naming: 'application.js',
  })
  assert.ok(built.success, 'Credential fixture build failed')
  await sign(app)
  prepared = await inventory(app)
  report['preparedArtifact'] = prepared
  if (mac) {
    const list = await tool(['/usr/bin/security', 'list-keychains', '-d', 'user'])
    originalKeychains = list
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        assert.match(line, /^"[^"\r\n]+"$/)
        return line.slice(1, -1)
      })
    const password = randomBytes(32).toString('base64')
    await tool(['/usr/bin/security', 'create-keychain', '-p', password, keychain])
    keychainCreated = true
    await tool(['/usr/bin/security', 'unlock-keychain', '-p', password, keychain])
    await tool([
      '/usr/bin/security',
      'add-generic-password',
      '-s',
      `Bunly ${applicationId} Safe Storage`,
      '-a',
      applicationId,
      '-w',
      randomBytes(32).toString('base64'),
      '-T',
      executable(app),
      keychain,
    ])
    await tool(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', keychain])
    searchChanged = true
  } else if (process.platform === 'linux') {
    assert.ok(process.env['DBUS_SESSION_BUS_ADDRESS'], 'A disposable session bus is required')
    providerEnv['XDG_RUNTIME_DIR'] = join(work, 'keyring-runtime')
    providerEnv['XDG_DATA_HOME'] = join(work, 'keyring-data')
    await mkdir(providerEnv['XDG_RUNTIME_DIR'], { mode: 0o700 })
    await mkdir(providerEnv['XDG_DATA_HOME'], { mode: 0o700 })
    keyring = Bun.spawn(
      ['gnome-keyring-daemon', '--foreground', '--components=secrets', '--unlock'],
      { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...providerEnv } }
    )
    const input = keyring.stdin
    assert.ok(input && typeof input !== 'number')
    input.write(randomBytes(32).toString('base64') + '\n')
    input.end()
    await tool(['gdbus', 'wait', '--session', '--timeout', '10', 'org.freedesktop.secrets'])
    assert.equal(keyring.exitCode, null, 'Owned Secret Service exited prematurely')
  }
  await launch('seed')
  await launch('present')
  await launch('clear')
  await launch('cleared')
  await launch('intent-denied')
  const mismatched = join(work, mac ? 'Mismatch.app' : 'Mismatch Native')
  await cp(app, mismatched, { recursive: true, dereference: false })
  const wrong = structuredClone(config)
  ;(wrong['credential_policy'] as Record<string, unknown>)['applicationId'] = 'dev.bunly.other'
  await writeFile(join(resources(mismatched), 'runtime.json'), JSON.stringify(wrong))
  await sign(mismatched)
  const mismatch = await observedCommand([executable(mismatched)], {
    cwd: work,
    output: join(work, 'mismatch.process.json'),
    timeoutMs: 30000,
    env: common('mismatch'),
  }).result
  trials.push({ name: 'identity-mismatch', observation: mismatch })
  acceptNativeRejection(mismatch, 'Persistent root credential identity/provider changed')
  for (const argument of ['--password-store=basic', '--use-mock-keychain']) {
    const name = argument.slice(2).split('=')[0]!
    const observation = await observedCommand([executable(app), argument], {
      cwd: work,
      output: join(work, name + '.process.json'),
      timeoutMs: 30000,
      env: common(name),
    }).result
    trials.push({ name: 'reject-' + name, observation })
    acceptNativeRejection(
      observation,
      'Credential-enabled runtime rejects encryption/provider feature overrides'
    )
  }
  // An interrupted admission can have persisted encrypted canary bytes but no
  // completed seal. Reopening must read, never overwrite, that existing canary.
  const interruptedRoot = join(profileWork, 'i')
  await cp(profileRoot, interruptedRoot, { recursive: true, dereference: false })
  const proofMarker = join(
    interruptedRoot,
    'bunly-profile-' + createHash('sha256').update('bunly-internal-credential-proof').digest('hex'),
    '.bunly-credential-proof.json'
  )
  const interruptedSeal = JSON.parse(await readFile(proofMarker, 'utf8')) as Record<string, unknown>
  assert.equal(interruptedSeal['ready'], true)
  interruptedSeal['ready'] = false
  await writeFile(proofMarker, JSON.stringify(interruptedSeal))
  const unavailable = async (changes: Record<string, string>) => {
    await launch('unavailable', changes)
    await launch(
      'unavailable',
      { ...changes, BUNLY_PROFILE_ROOT: interruptedRoot },
      'unsealed-unavailable'
    )
    const after = JSON.parse(await readFile(proofMarker, 'utf8')) as Record<string, unknown>
    assert.deepEqual(
      after,
      interruptedSeal,
      'Unavailable provider must not replace or seal an interrupted proof'
    )
    report['interruptedSealPreserved'] = true
  }
  if (mac) {
    await tool(['/usr/bin/security', 'lock-keychain', keychain])
    await unavailable({ BUNLY_PROFILE_ROOT: join(profileWork, 'u') })
    report['unavailabilityControl'] = 'locked-disposable-keychain-no-permission-ui'
  } else if (process.platform === 'linux') {
    await unavailable({
      BUNLY_PROFILE_ROOT: join(profileWork, 'u'),
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(work, 'absent-session-bus'),
    })
    report['unavailabilityControl'] = 'absent-private-secret-service-rejects-basic-fallback'
  } else {
    const broken = join(profileWork, 'u')
    await cp(profileRoot, broken, { recursive: true, dereference: false })
    const localState = join(broken, 'Local State')
    const state = JSON.parse(await readFile(localState, 'utf8'))
    state.os_crypt.encrypted_key = Buffer.concat([Buffer.from('DPAPI'), randomBytes(64)]).toString(
      'base64'
    )
    await writeFile(localState, JSON.stringify(state))
    // Both roots are private copies; preserve the distinct sealed/unsealed marker.
    await writeFile(join(interruptedRoot, 'Local State'), JSON.stringify(state))
    await unavailable({ BUNLY_PROFILE_ROOT: broken })
    report['unavailabilityControl'] = 'unreadable-DPAPI-envelope-in-private-root-copy'
  }
  if (keyring) assert.equal(keyring.exitCode, null, 'Owned Secret Service exited prematurely')
  if (mac)
    assert.ok(
      successes.some((item) => item.postExitCleanup?.qualified),
      'No positively verified helper cleanup in fixed credential suite'
    )
  assert.deepEqual(await inventory(app), prepared)
  assert.deepEqual(await inventory(inputRoot), original)
  report['inputArtifactUnchanged'] = true
  report['preparedArtifactUnchanged'] = true
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  try {
    if (searchChanged && originalKeychains)
      await tool(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', ...originalKeychains])
    if (keychainCreated) await tool(['/usr/bin/security', 'delete-keychain', keychain])
    if (keyring) {
      if (keyring.exitCode === null) keyring.kill('SIGTERM')
      const timer = setTimeout(() => keyring?.kill('SIGKILL'), 3000)
      try {
        await keyring.exited
      } finally {
        clearTimeout(timer)
      }
    }
    report['providerCleanupCompleted'] = true
  } catch {
    report.passed = false
    report['providerCleanupCompleted'] = false
    report['cleanupFailure'] = 'Disposable OS-provider cleanup failed'
  }
  await server?.stop(true)
  report['sourceAfter'] = sourceIdentity(root)
  report['sourceHashesAfter'] = await fingerprints()
  if (
    JSON.stringify(report['sourceBefore']) !== JSON.stringify(report['sourceAfter']) ||
    JSON.stringify(report['sourceHashes']) !== JSON.stringify(report['sourceHashesAfter'])
  ) {
    report.passed = false
    report['failure'] = 'Credential qualification source changed'
  }
  const output = join(work, 'report.json')
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(
    JSON.stringify({
      passed: report.passed,
      provider,
      trials: trials.length,
      output,
      failure: report['failure'],
    })
  )
}
if (!report.passed) process.exitCode = 1

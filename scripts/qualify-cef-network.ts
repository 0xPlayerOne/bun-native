/** Real CEF network authority, redirects and untrusted TLS; no verifier exceptions. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, lstat } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
import { acceptNativeNetwork } from '../benchmarks/lib/cef-network-acceptance.ts'

if (Bun.version !== '1.4.3') throw new Error('Use pinned Bun 1.4.3')
const argument = process.argv[2]
if (!argument || process.argv.length !== 3)
  throw new Error('Usage: bun scripts/qualify-cef-network.ts PREPARED_APP')
const root = resolve(import.meta.dir, '..')
const mac = process.platform === 'darwin'
const input = resolve(argument)
if ((await lstat(input)).isSymbolicLink())
  throw new Error('Prepared application must not be a symbolic link')
const inputRoot = mac ? input : dirname(input)
const original = await inventory(inputRoot)
const parent = join(root, '.bunly/m3/network')
await mkdir(parent, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(parent, 'run-'))
await chmod(work, 0o700)
const traffic = {
  forbidden: 0,
  untrustedTls: 0,
  child: 0,
  worker: 0,
  isolatedLeak: 0,
  allowedData: 0,
}
const report: Record<string, unknown> = {
  schema: 1,
  classification: 'native-network-functional-qualification',
  target: `${process.platform}-${process.arch}`,
  profile: 'session-origins-and-remote-authority',
  sourceBefore: sourceIdentity(root),
  inputArtifact: original,
  passed: false,
  traffic,
  limitations: [
    'Controlled cross-origin traffic uses numeric-loopback HTTP; a separate ordinary HTTPS navigation requires public example.com availability.',
    'TLS fixture uses an untrusted ephemeral certificate and must be denied by the unchanged verifier.',
    'Navigation and CEF HTTP resource rules are not a complete network firewall; WebSocket/WebRTC channels are outside this API.',
    'Not production signing, all-M4 acceptance, or a cure for the historical intermittent watchdog.',
  ],
}
const sources = [
  'scripts/qualify-cef-network.ts',
  'packages/runtime/src/native-transport.ts',
  'packages/runtime/src/native-capacity.json',
  'native/cef-host/src/command_budget.rs',
  'native/cef-host/src/process.rs',
  'native/cef-host/src/exit_notification.rs',
  'examples/cef/network.ts',
  'native/cef-host/src/network_policy.rs',
  'native/cef-host/src/scheme.rs',
  'native/cef-host/src/host.rs',
  'packages/runtime/src/cef.ts',
  'packages/contracts/src/network-policy.ts',
  'benchmarks/lib/cef-network-acceptance.ts',
  'scripts/observe-process.py',
]
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ])
    )
  )
report['sourceHashes'] = await fingerprints()
const publicHttps = 'https://example.com'
report['publicHttpsOrigin'] = publicHttps
const servers: { stop(close?: boolean): unknown }[] = []
const python = process.env['PYTHON'] ?? 'python3'
try {
  const openssl =
    Bun.which('openssl') ??
    (process.platform === 'win32'
      ? join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')
      : undefined)
  if (!openssl)
    throw new Error('OpenSSL is required to create the private untrusted certificate fixture')
  await writeFile(
    join(work, 'openssl.cnf'),
    `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=bunly-untrusted.invalid
[ext]
subjectAltName=IP:127.0.0.1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`
  )
  assertCleanCommand(
    await observedCommand(
      [
        openssl,
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(work, 'key.pem'),
        '-out',
        join(work, 'cert.pem'),
        '-days',
        '1',
        '-config',
        join(work, 'openssl.cnf'),
      ],
      { cwd: work, output: join(work, 'certificate.process.json'), timeoutMs: 10000 }
    ).result
  )
  await chmod(join(work, 'key.pem'), 0o600)
  const forbidden = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      traffic.forbidden++
      return new Response('not authorized')
    },
  })
  servers.push(forbidden)
  const blocked = forbidden.url.origin
  const tls = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: Bun.file(join(work, 'key.pem')), cert: Bun.file(join(work, 'cert.pem')) },
    fetch() {
      traffic.untrustedTls++
      return new Response('must not reach application')
    },
  })
  servers.push(tls)
  const tlsOrigin = `https://127.0.0.1:${tls.port}`
  const html = (value: string) =>
    new Response(value, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })
  const script = (value: string) =>
    new Response(value, {
      headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
    })
  const second = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname
      if (path === '/data') {
        traffic.allowedData++
        return new Response('second', { headers: { 'access-control-allow-origin': '*' } })
      }
      if (path === '/isolated-leak') {
        traffic.isolatedLeak++
        return new Response('leaked', { headers: { 'access-control-allow-origin': '*' } })
      }
      if (path === '/child') {
        traffic.child++
        return html(
          `<script>try{if(typeof __bunlyRpc!=='undefined'||typeof Bun!=='undefined')throw new Error('child bridge');let denied=false;try{void parent.__bunlyRpc}catch(e){denied=e.name==='SecurityError'}if(!denied)throw new Error('parent access');parent.postMessage('NETWORK_CHILD_DENIED',${JSON.stringify(first.url.origin)})}catch(e){console.error('BUNLY_NETWORK_FAILED:'+String(e))}</script>`
        )
      }
      return html(
        `<script>if(typeof globalThis.__bunlyRpc!=='undefined'||typeof globalThis.Bun!=='undefined')console.error('BUNLY_NETWORK_FAILED:remote bridge');else console.log('BUNLY_NETWORK_LANDING_OK')</script>`
      )
    },
  })
  servers.push(second)
  const remoteScript = `const check=(v,m)=>{if(!v)throw new Error(m)};void(async()=>{try{
    const phase=new URL(location.href).searchParams.get('phase');
    check(typeof globalThis.__bunlyRpc==='undefined'&&typeof globalThis.Bun==='undefined'&&typeof globalThis.process==='undefined','remote authority');
    check(await(await fetch('/data')).text()==='first','first data');
    check(await(await fetch(${JSON.stringify(second.url.origin + '/data')})).text()==='second','second data');
    for(const path of [${JSON.stringify(blocked + '/fetch')},'/resource-redirect'])
      await fetch(path).then(()=>{throw new Error('forbidden fetch resolved')},e=>check(e instanceof TypeError,'unexpected fetch error'));
    const child=document.createElement('iframe');
    const childReady=new Promise((ok,bad)=>{const timer=setTimeout(()=>bad(new Error('child timeout')),5000);const onMessage=e=>{if(e.source===child.contentWindow&&e.origin===${JSON.stringify(second.url.origin)}&&e.data==='NETWORK_CHILD_DENIED'){clearTimeout(timer);removeEventListener('message',onMessage);ok()}};addEventListener('message',onMessage)});
    child.src=${JSON.stringify(second.url.origin + '/child')};document.body.append(child);await childReady;
    for(const [tag,path] of [['iframe','/frame'],['script','/script']]){const element=document.createElement(tag);element.src=${JSON.stringify(blocked)}+path;document.body.append(element);}
    check(navigator.serviceWorker,'service worker unavailable');
    const registration=await navigator.serviceWorker.register('/worker.js');await navigator.serviceWorker.ready;
    await new Promise((ok,bad)=>{const timer=setTimeout(()=>bad(new Error('worker timeout')),5000);const receive=e=>{if(e.source!==registration.active)return;clearTimeout(timer);navigator.serviceWorker.removeEventListener('message',receive);e.data==='NETWORK_WORKER_DENIED'?ok():bad(new Error('worker escaped policy'))};navigator.serviceWorker.addEventListener('message',receive);registration.active.postMessage('probe')});
    check(await registration.unregister(),'worker unregister');
    console.log('BUNLY_NETWORK_REMOTE_OK:'+phase);
  }catch(e){console.error('BUNLY_NETWORK_FAILED:'+String(e))}})();`
  const first = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname
      if (path === '/data') {
        traffic.allowedData++
        return new Response('first')
      }
      if (path === '/redirect-allowed')
        return Response.redirect(second.url.origin + '/landing', 302)
      if (path === '/redirect-denied' || path === '/resource-redirect')
        return Response.redirect(blocked + '/redirect-target', 302)
      if (path === '/remote.js') return script(remoteScript)
      if (path === '/worker.js') {
        traffic.worker++
        return script(
          `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.waitUntil(fetch(${JSON.stringify(blocked + '/worker')}).then(()=>e.source.postMessage('NETWORK_WORKER_ESCAPED'),()=>e.source.postMessage('NETWORK_WORKER_DENIED'))));`
        )
      }
      if (path === '/isolated')
        return html(
          `<script>fetch(${JSON.stringify(second.url.origin + '/isolated-leak')}).then(()=>console.error('BUNLY_NETWORK_FAILED:session origin leaked'),()=>console.log('BUNLY_NETWORK_ISOLATED_OK'))</script>`
        )
      return html('<!doctype html><title>Remote fixture</title><script src="/remote.js"></script>')
    },
  })
  servers.push(first)
  const application = join(work, mac ? 'Network.app' : 'Network Unicode é Ω')
  await cp(inputRoot, application, { recursive: true, dereference: false })
  const resources = join(application, mac ? 'Contents/Resources' : 'resources')
  const config = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8'))
  assert.equal(
    config.development_origin,
    undefined,
    'Network acceptance requires ordinary packaged navigation, not development fallback'
  )
  const build = await Bun.build({
    entrypoints: [join(root, 'examples/cef/network.ts')],
    outdir: join(resources, 'backend'),
    naming: 'application.js',
    target: 'bun',
  })
  assert.equal(build.success, true, String(build.logs))
  if (mac) {
    const signScript = join(work, 'sign.py')
    await writeFile(
      signScript,
      [
        'import sys,subprocess',
        'from pathlib import Path',
        `sys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})`,
        'from qualify_adhoc_signing import targets',
        `for p in targets(Path(${JSON.stringify(application)})): subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)`,
        '',
      ].join('\n')
    )

    assertCleanCommand(
      await observedCommand([python, signScript], {
        cwd: root,
        output: join(work, 'sign.process.json'),
        timeoutMs: 30000,
      }).result
    )
  }
  const executable = mac
    ? join(application, 'Contents/MacOS/bunly_host')
    : join(application, basename(input))
  const observation = await observedCommand([executable], {
    cwd: work,
    output: join(work, 'native.process.json'),
    timeoutMs: 30000,
    env: {
      BUNLY_CACHE_DIR: join(work, 'cache'),
      BUNLY_NETWORK_FIRST: first.url.origin,
      BUNLY_NETWORK_SECOND: second.url.origin,
      BUNLY_NETWORK_BLOCKED: blocked,
      BUNLY_NETWORK_TLS: tlsOrigin,
      BUNLY_NETWORK_PUBLIC_HTTPS: publicHttps,
    },
  }).result
  report['observation'] = observation
  acceptNativeNetwork(observation, traffic)
  assert.deepEqual(await inventory(inputRoot), original, 'Network qualifier changed the input app')
  report['sourceArtifactUnchanged'] = true
  report.passed = true
} catch (error) {
  report['failure'] = error instanceof Error ? error.message : String(error)
} finally {
  for (const server of servers) await server.stop(true)
  report['sourceAfter'] = sourceIdentity(root)
  report['sourceHashesAfter'] = await fingerprints()
  if (JSON.stringify(report['sourceHashesAfter']) !== JSON.stringify(report['sourceHashes'])) {
    report.passed = false
    report['failure'] = 'Harness changed during network qualification'
  }
  const output = join(work, 'report.json')
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(
    JSON.stringify({ passed: report.passed, output, traffic, failure: report['failure'] })
  )
}
if (!report.passed) process.exitCode = 1

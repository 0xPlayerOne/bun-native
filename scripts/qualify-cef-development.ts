/** Verify explicit development origin and redirect/subresource denial using real CEF. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inventory } from '../benchmarks/lib/inventory.ts'
import { sourceIdentity } from '../benchmarks/lib/source-identity.ts'
import {
  acceptNativePolicy,
  nativePolicyCallbacks,
} from '../benchmarks/lib/cef-policy-acceptance.ts'
import { cefQualificationOptions, qualificationConfig } from '../benchmarks/lib/cef-profile.ts'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import {
  observeNativeShutdown,
  requireNativeShutdown,
} from '../benchmarks/foundation/native-shutdown.ts'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
const root = resolve(import.meta.dir, '..'),
  qualification = cefQualificationOptions(process.argv.slice(2)),
  appArgument = qualification.artifact,
  python = process.env['PYTHON'] ?? 'python3'
if (
  !['darwin-arm64', 'linux-x64', 'win32-x64'].includes(`${process.platform}-${process.arch}`) ||
  !appArgument
)
  throw new Error(
    'Pass a prebuilt app directory on macOS, or the native executable on Linux/Windows'
  )
const mac = process.platform === 'darwin'
const inputRoot = mac ? resolve(appArgument) : dirname(resolve(appArgument))
const original = await inventory(inputRoot)
const sourceBefore = sourceIdentity(root)
const paths = [
  'scripts/qualify-cef-development.ts',
  'packages/runtime/src/native-transport.ts',
  'packages/runtime/src/native-capacity.json',
  'native/cef-host/src/command_budget.rs',
  'native/cef-host/src/process.rs',
  'examples/cef/development.ts',
  'packages/runtime/src/cef.ts',
  'benchmarks/lib/cef-policy-acceptance.ts',
  'benchmarks/lib/observed-command.ts',
  'benchmarks/foundation/native-shutdown.ts',
  'scripts/observe-process.py',
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
const sourceHashes = await fingerprints()
await mkdir(join(root, '.bunly/m3/development'), { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(root, '.bunly/m3/development/run-'))
let deniedRequests = 0
const denied = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      deniedRequests++
      return new Response('not authorized')
    },
  }),
  blocked = denied.url.origin
// Do not hold module evaluation open while awaiting a grant that is issued
// after native document readiness; that would deadlock against OnLoadEnd.
const js = `const check=(v,m)=>{if(!v)throw new Error(m)};const stage=s=>console.log('DEV_POLICY_STAGE:'+s);void(async()=>{try{console.log('DEV_READY');check(await (await fetch('/armed')).text()==='yes','policy grant was not armed');stage('armed');check((await (await fetch('/data')).text())==='allowed','same-origin failed');for(const path of [${JSON.stringify(blocked + '/fetch')},'/resource-redirect']){await fetch(path).then(()=>{throw new Error('Forbidden resource resolved')},e=>check(e instanceof TypeError,'wrong failure'))};stage('fetch-denials');const hostile=document.createElement('iframe');hostile.src=${JSON.stringify(blocked + '/frame')};document.body.append(hostile);const script=document.createElement('script');script.src=${JSON.stringify(blocked + '/script')};document.head.append(script);const popup=new Promise((ok,bad)=>{const button=document.createElement('button');button.id='bunly-policy-popup';button.textContent='Policy popup probe';button.style.cssText='position:fixed;left:0;top:0;width:200px;height:100px;z-index:99999';button.addEventListener('click',()=>{try{stage('activated');check(window.open('/popup','_blank')===null,'popup was created');check(window.open('custom-protocol://host/value','_blank')===null,'external protocol popup was created');button.remove();ok()}catch(e){bad(e)}},{once:true});document.body.append(button);button.focus();button.getBoundingClientRect();console.log('DEV_POPUP_READY')});await popup;const download=document.createElement('a');download.href='/download';download.download='denied.txt';document.body.append(download);download.click();check(navigator.mediaDevices?.getUserMedia,'media callback API unavailable');stage('permission-requests');const media=navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(()=>{throw new Error('media permission granted')},()=>{stage('media-denied')});check(navigator.geolocation,'geolocation callback API unavailable');const childDenied=new Promise((ok,bad)=>{const timer=setTimeout(()=>bad(new Error('same-origin child permission timed out')),3000);const receive=event=>{if(event.origin!==location.origin||event.data!=='CHILD_GEO_DENIED')return;removeEventListener('message',receive);clearTimeout(timer);stage('child-denied');ok()};addEventListener('message',receive);const child=document.createElement('iframe');child.src='/permission-child';document.body.append(child)});await Promise.all([media,childDenied]);stage('permission-complete');await new Promise(r=>setTimeout(r,200));check(location.pathname==='/'&&document.querySelectorAll('iframe').length===2,'denied callback changed the document');check(typeof globalThis.Bun==='undefined'&&typeof globalThis.process==='undefined'&&typeof globalThis.require==='undefined','native authority leaked');console.log('DEV_TEST_OK')}catch(e){console.error('DEV_TEST_FAILED:'+String(e))}})()`
let armPolicy!: () => void
const policyArmed = new Promise<void>((resolve) => {
  armPolicy = resolve
})
const allowed = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request): Promise<Response> {
    const p = new URL(request.url).pathname
    if (p === '/allowed-redirect') return Response.redirect(allowed.url.origin + '/next', 302)
    if (p === '/resource-redirect' || p === '/denied-redirect')
      return Response.redirect(blocked + '/redirect-target', 302)
    if (p === '/data') return new Response('allowed')
    if (p === '/arm' && request.method === 'POST') {
      armPolicy()
      return new Response('ok')
    }
    if (p === '/armed') {
      await policyArmed
      return new Response('yes')
    }
    if (p === '/main.js')
      return new Response(js, { headers: { 'content-type': 'text/javascript' } })
    if (p === '/permission-child')
      return new Response(
        `<!doctype html><script>navigator.geolocation.getCurrentPosition(()=>parent.postMessage('CHILD_GEO_GRANTED',location.origin),()=>parent.postMessage('CHILD_GEO_DENIED',location.origin))</script>`,
        { headers: { 'content-type': 'text/html' } }
      )
    return new Response(
      p === '/next'
        ? '<title>Next</title>'
        : '<!doctype html><title>Explicit dev fixture</title><script type="module" src="/main.js"></script>',
      { headers: { 'content-type': 'text/html' } }
    )
  },
})
const app = join(work, mac ? 'Dev.app' : 'Development Unicode é Ω')
await cp(mac ? resolve(appArgument) : dirname(resolve(appArgument)), app, {
  recursive: true,
  dereference: false,
})
const resources = join(app, mac ? 'Contents/Resources' : 'resources')
const executable = mac ? join(app, 'Contents/MacOS/bunly_host') : join(app, basename(appArgument))
const report: Record<string, unknown> = {
  schema: 1,
  passed: false,
  classification: 'native-policy-functional-acceptance',
  sourceBefore,
  sourceHashes,
  inputArtifact: original,
  profile: 'explicit-development-origin-native-policy',
  target: `${process.platform}-${process.arch}`,
  deadlineProfile: qualification.profile,
  deniedRequests: 0,
}
const expectedPolicyCallbacks = nativePolicyCallbacks

try {
  const config = qualificationConfig(
    JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')),
    qualification.emulated
  )
  config.development_origin = allowed.url.origin
  await writeFile(join(resources, 'runtime.json'), JSON.stringify(config))
  const build = await Bun.build({
    entrypoints: [join(root, 'examples/cef/development.ts')],
    target: 'bun',
    outdir: join(resources, 'backend'),
    naming: 'application.js',
  })
  assert.equal(build.success, true)
  if (mac) {
    const helper = join(work, 'sign.py')
    await writeFile(
      helper,
      `import sys,subprocess\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})\nfrom qualify_adhoc_signing import targets\nfor p in targets(Path(${JSON.stringify(app)})):subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(p)],check=True,capture_output=True)\n`
    )
    assertCleanCommand(
      await observedCommand([python, helper], {
        cwd: root,
        output: join(work, 'sign.process.json'),
        timeoutMs: 30000,
      }).result
    )
  }
  const observation = await observedCommand([executable], {
    cwd: work,
    output: join(work, 'native.process.json'),
    timeoutMs: qualification.emulated ? 300000 : 30000,
    env: {
      BUNLY_POLICY_QUALIFICATION: '1',
      BUNLY_TEST_ORIGIN: allowed.url.origin,
      BUNLY_TEST_PAGE_TIMEOUT_MS: String(qualification.pageTimeoutMs),
      BUNLY_TEST_DENIED_ORIGIN: blocked,
      BUNLY_CACHE_DIR: join(work, 'cache'),
    },
  }).result
  report['observation'] = observation
  assertCleanCommand(observation)
  report['shutdownStages'] = requireNativeShutdown(observeNativeShutdown(observation))
  acceptNativePolicy(observation, deniedRequests)
  assert.deepEqual(
    await inventory(inputRoot),
    original,
    'Native policy qualification changed input artifact'
  )
  report['sourceArtifactUnchanged'] = true
  report.passed = true
} catch (e) {
  report['failure'] = e instanceof Error ? e.message : String(e)
} finally {
  const sourceHashesAfter = await fingerprints()
  report['sourceHashesAfter'] = sourceHashesAfter
  report['sourceAfter'] = sourceIdentity(root)
  if (JSON.stringify(sourceHashesAfter) !== JSON.stringify(sourceHashes)) {
    report.passed = false
    report['failure'] = 'Policy qualification source changed during execution'
  }
  report.deniedRequests = deniedRequests
  report.expectedPolicyCallbacks = expectedPolicyCallbacks
  await allowed.stop(true)
  await denied.stop(true)
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      passed: report.passed,
      deniedRequests,
      output: join(work, 'report.json'),
      failure: report['failure'],
    })
  )
}
if (!report.passed) process.exitCode = 1

/** Verify explicit development origin and redirect/subresource denial using real CEF. */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname, basename } from 'node:path'
import { observedCommand, assertCleanCommand } from '../benchmarks/lib/observed-command.ts'
const root = resolve(import.meta.dir, '..'),
  appArgument = process.argv[2],
  python = process.env['PYTHON'] ?? 'python3'
if (
  !['darwin-arm64', 'linux-x64', 'win32-x64'].includes(`${process.platform}-${process.arch}`) ||
  !appArgument ||
  process.argv.length !== 3
)
  throw new Error(
    'Pass a prebuilt app directory on macOS, or the native executable on Linux/Windows'
  )
const mac = process.platform === 'darwin'
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
const js = `const check=(v,m)=>{if(!v)throw new Error(m)};try{check((await (await fetch('/data')).text())==='allowed','same-origin failed');for(const path of [${JSON.stringify(blocked + '/fetch')},'/resource-redirect']){await fetch(path).then(()=>{throw new Error('Forbidden resource resolved')},e=>check(e instanceof TypeError,'wrong failure'))};const frame=document.createElement('iframe');frame.src=${JSON.stringify(blocked + '/frame')};document.body.append(frame);const script=document.createElement('script');script.src=${JSON.stringify(blocked + '/script')};document.head.append(script);await new Promise(r=>setTimeout(r,200));check(typeof globalThis.Bun==='undefined'&&typeof globalThis.process==='undefined'&&typeof globalThis.require==='undefined','native authority leaked');console.log('DEV_TEST_OK')}catch(e){console.error('DEV_TEST_FAILED:'+String(e))}`
const allowed = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request): Response {
    const p = new URL(request.url).pathname
    if (p === '/allowed-redirect') return Response.redirect(allowed.url.origin + '/next', 302)
    if (p === '/resource-redirect' || p === '/denied-redirect')
      return Response.redirect(blocked + '/redirect-target', 302)
    if (p === '/data') return new Response('allowed')
    if (p === '/main.js')
      return new Response(js, { headers: { 'content-type': 'text/javascript' } })
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
  profile: 'explicit-development-origin-native-policy',
  target: `${process.platform}-${process.arch}`,
  deniedRequests: 0,
}
try {
  const config = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8'))
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
    timeoutMs: 30000,
    env: {
      BUNLY_TEST_ORIGIN: allowed.url.origin,
      BUNLY_TEST_DENIED_ORIGIN: blocked,
      BUNLY_CACHE_DIR: join(work, 'cache'),
    },
  }).result
  report['observation'] = observation
  assertCleanCommand(observation)
  assert.ok(
    observation.stderr.some(
      (s) => s.includes('"event":"bunly.native.development"') && s.includes('"passed":true')
    )
  )
  assert.equal(
    deniedRequests,
    0,
    'Native policy must block forbidden origins before any server request'
  )
  report.passed = true
} catch (e) {
  report['failure'] = e instanceof Error ? e.message : String(e)
} finally {
  report.deniedRequests = deniedRequests
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

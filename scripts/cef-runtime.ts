/** Compiler-free runtime cache commands. Trust policy is always an explicit local input. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  resolveCefRuntime,
  removeCefRuntime,
  type CefResolveOptions,
} from '../packages/artifacts/src/cef-cache.ts'
const [command, policyFile, cache, ...extra] = process.argv.slice(2)
if (
  !['acquire', 'inspect', 'remove'].includes(command ?? '') ||
  !policyFile ||
  !cache ||
  extra.length
)
  throw new Error(
    'Usage: bun scripts/cef-runtime.ts acquire|inspect|remove <trusted-policy.json> <cache-directory>'
  )
const text = await readFile(policyFile, 'utf8')
if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Oversized local runtime policy')
const policy = JSON.parse(text) as Pick<
  CefResolveOptions,
  'envelope' | 'expected' | 'trustRoots' | 'allowedOrigins'
>
if (
  !policy ||
  typeof policy !== 'object' ||
  Object.keys(policy).sort().join('|') !== 'allowedOrigins|envelope|expected|trustRoots' ||
  !Array.isArray(policy.allowedOrigins)
)
  throw new Error('Invalid trusted runtime policy')
const options: CefResolveOptions = {
  ...policy,
  cacheRoot: resolve(cache),
  timeoutMs: 120000,
  offline: command === 'inspect',
}
if (command === 'remove') {
  await removeCefRuntime(options)
  console.log(JSON.stringify({ removed: true, nativeCompilation: false }))
} else {
  const result = await resolveCefRuntime(options)
  console.log(
    JSON.stringify({
      directory: result.directory,
      cacheHit: result.cacheHit,
      identity: result.manifest.identity,
      offline: options.offline,
      nativeCompilation: false,
    })
  )
}

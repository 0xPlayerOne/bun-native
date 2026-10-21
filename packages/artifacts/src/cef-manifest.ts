/** Authenticated complete-runtime inventory; distinct from the small M1 probe profile. */
import { createPublicKey, verify } from 'node:crypto'
import { posix } from 'node:path'
import { ArtifactError, safeRelativePath, type SignedManifest } from './manifest.ts'
export const CEF_MAX_BYTES = 16 * 1024 ** 3
export interface CefRuntimeIdentity {
  readonly kind: 'cef-runtime'
  readonly version: string
  readonly abi: 1
  readonly target: 'darwin-arm64' | 'linux-x64' | 'win32-x64'
  readonly bun: string
  readonly cef: string
  readonly chromium: string
  readonly cefRs: string
  readonly nativeToolchain: string
}
export type CefMember =
  | {
      readonly path: string
      readonly type: 'file'
      readonly mode: number
      readonly size: number
      readonly sha256: string
    }
  | { readonly path: string; readonly type: 'directory'; readonly mode: number }
  | { readonly path: string; readonly type: 'symlink'; readonly target: string }
export interface CefRuntimeManifest {
  readonly schema: 2
  readonly identity: CefRuntimeIdentity
  readonly archive: {
    readonly url: string
    readonly size: number
    readonly sha256: string
    readonly tarBytes: number
    readonly format: 'ustar-gzip'
  }
  readonly members: readonly CefMember[]
  readonly layout: {
    readonly executable: string
    readonly bun: string
    readonly resources: string
    readonly helpers: readonly string[]
  }
  readonly notices: readonly string[]
  readonly locales: 'all'
  readonly debugSymbols: false
}
export function cefError(code: string, message: string): never {
  throw new ArtifactError(code, message)
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    cefError('BAD_MANIFEST', 'Expected manifest object')
  return v as Record<string, unknown>
}
function keys(v: Record<string, unknown>, wanted: readonly string[]) {
  if (Object.keys(v).sort().join('|') !== [...wanted].sort().join('|'))
    cefError('BAD_MANIFEST', 'Unknown or missing manifest fields')
}
export const cefHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function count(v: unknown, min: number): asserts v is number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > CEF_MAX_BYTES)
    cefError('BAD_MANIFEST', 'Invalid bounded byte count')
}
export function cefIdentity(v: unknown): CefRuntimeIdentity {
  const i = object(v)
  keys(i, [
    'kind',
    'version',
    'abi',
    'target',
    'bun',
    'cef',
    'chromium',
    'cefRs',
    'nativeToolchain',
  ])
  if (
    i['kind'] !== 'cef-runtime' ||
    i['abi'] !== 1 ||
    !['darwin-arm64', 'linux-x64', 'win32-x64'].includes(String(i['target'])) ||
    !/^[a-f0-9]{40}$/.test(String(i['cefRs'])) ||
    !/^rust-\d+\.\d+\.\d+$/.test(String(i['nativeToolchain']))
  )
    cefError('BAD_MANIFEST', 'Invalid runtime identity')
  for (const k of ['version', 'bun', 'cef'])
    if (typeof i[k] !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(i[k] as string))
      cefError('BAD_MANIFEST', 'Unpinned runtime version')
  if (typeof i['chromium'] !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(i['chromium']))
    cefError('BAD_MANIFEST', 'Unpinned Chromium version')
  return { ...i } as unknown as CefRuntimeIdentity
}
export function cefLinkTarget(path: string, target: string): string {
  if (
    typeof target !== 'string' ||
    !target ||
    Buffer.byteLength(target) > 100 ||
    target.startsWith('/') ||
    Array.from(target).some(
      (c) => c === '\\' || c === ':' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
    )
  )
    cefError('UNSAFE_PATH', 'Invalid runtime symlink')
  const resolved = posix.normalize(posix.join(posix.dirname(path), target))
  safeRelativePath(resolved)
  return resolved
}
export function parseCefManifest(value: unknown): CefRuntimeManifest {
  const m = object(value)
  keys(m, [
    'schema',
    'identity',
    'archive',
    'members',
    'layout',
    'notices',
    'locales',
    'debugSymbols',
  ])
  if (m['schema'] !== 2 || m['locales'] !== 'all' || m['debugSymbols'] !== false)
    cefError('BAD_MANIFEST', 'Unsupported full-runtime profile')
  const identity = cefIdentity(m['identity']),
    a = object(m['archive'])
  keys(a, ['url', 'size', 'sha256', 'tarBytes', 'format'])
  count(a['size'], 1)
  count(a['tarBytes'], 1024)
  if (
    a['format'] !== 'ustar-gzip' ||
    !cefHash(a['sha256']) ||
    typeof a['url'] !== 'string' ||
    a['url'].length > 8192 ||
    Number(a['tarBytes']) % 512
  )
    cefError('BAD_MANIFEST', 'Invalid runtime archive')
  let url: URL
  try {
    url = new URL(a['url'] as string)
  } catch {
    return cefError('BAD_MANIFEST', 'Invalid archive URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    cefError('BAD_MANIFEST', 'Runtime archive requires credential-free HTTPS')
  if (!Array.isArray(m['members']) || !m['members'].length || m['members'].length > 20000)
    cefError('BAD_MANIFEST', 'Invalid runtime member count')
  const names = new Map<string, CefMember>(),
    aliases = new Set<string>()
  let bytes = 0
  for (const raw of m['members']) {
    const f = object(raw)
    if (typeof f['path'] !== 'string') cefError('BAD_MANIFEST', 'Missing runtime path')
    const path = safeRelativePath(f['path'] as string),
      alias = path.normalize('NFC').toLowerCase()
    if (aliases.has(alias)) cefError('BAD_MANIFEST', 'Duplicate or aliasing runtime path')
    aliases.add(alias)
    if (f['type'] === 'file') {
      keys(f, ['path', 'type', 'mode', 'size', 'sha256'])
      count(f['size'], 0)
      if (!cefHash(f['sha256'])) cefError('BAD_MANIFEST', 'Missing file digest')
      bytes += Number(f['size'])
    } else if (f['type'] === 'directory') {
      keys(f, ['path', 'type', 'mode'])
      if (![0o700, 0o755].includes(Number(f['mode'])))
        cefError('BAD_MANIFEST', 'Runtime directories require safe traversal permissions')
    } else if (f['type'] === 'symlink') {
      keys(f, ['path', 'type', 'target'])
      cefLinkTarget(path, f['target'] as string)
    } else cefError('BAD_MANIFEST', 'Special runtime members are forbidden')
    if (
      f['type'] !== 'symlink' &&
      (typeof f['mode'] !== 'number' || ![0o600, 0o644, 0o700, 0o755].includes(f['mode']))
    )
      cefError('BAD_MANIFEST', 'Unsafe runtime mode')
    names.set(path, { ...f } as unknown as CefMember)
  }
  if (bytes > CEF_MAX_BYTES || bytes > Number(a['tarBytes']))
    cefError('BAD_MANIFEST', 'Expanded runtime exceeds manifest limits')
  for (const f of names.values()) {
    let parent = posix.dirname(f.path)
    while (parent !== '.') {
      if (names.get(parent)?.type !== 'directory')
        cefError('BAD_MANIFEST', 'Missing directory or write through runtime symlink')
      parent = posix.dirname(parent)
    }
    if (f.type === 'symlink') {
      let target = cefLinkTarget(f.path, f.target)
      const seen = new Set<string>([f.path])
      for (let n = 0; n <= 64; n++) {
        let changed = false
        const parts = target.split('/')
        for (let j = 1; j <= parts.length; j++) {
          const prefix = parts.slice(0, j).join('/'),
            link = names.get(prefix)
          if (link?.type === 'symlink') {
            if (seen.has(prefix)) cefError('BAD_MANIFEST', 'Cyclic runtime symlink')
            seen.add(prefix)
            target = posix.join(cefLinkTarget(prefix, link.target), ...parts.slice(j))
            changed = true
            break
          }
        }
        if (!changed) {
          if (!names.has(target)) cefError('BAD_MANIFEST', 'Dangling runtime symlink')
          break
        }
        if (n === 64) cefError('BAD_MANIFEST', 'Runtime symlink depth exceeded')
      }
    }
  }
  const l = object(m['layout'])
  keys(l, ['executable', 'bun', 'resources', 'helpers'])
  for (const k of ['executable', 'bun']) {
    if (typeof l[k] !== 'string') cefError('BAD_MANIFEST', 'Invalid runtime layout path')
    const file = names.get(String(l[k]))
    if (file?.type !== 'file' || !(file.mode & 0o111))
      cefError('BAD_MANIFEST', 'Missing executable runtime component')
  }
  if (
    typeof l['resources'] !== 'string' ||
    names.get(String(l['resources']))?.type !== 'directory' ||
    !Array.isArray(l['helpers']) ||
    !l['helpers'].length ||
    l['helpers'].length > 32
  )
    cefError('BAD_MANIFEST', 'Missing resources/helpers')
  const runtimeConfig = names.get(String(l['resources']) + '/runtime.json')
  if (runtimeConfig?.type !== 'file' || runtimeConfig.size > 8192)
    cefError('BAD_MANIFEST', 'Missing bounded runtime configuration')
  for (const h of l['helpers']) {
    const helper = typeof h === 'string' ? names.get(h) : undefined
    if (helper?.type !== 'file' || !(helper.mode & 0o111))
      cefError('BAD_MANIFEST', 'Missing executable native helper')
  }
  if (new Set(l['helpers']).size !== l['helpers'].length)
    cefError('BAD_MANIFEST', 'Duplicate native helper')
  if (
    !Array.isArray(m['notices']) ||
    !m['notices'].length ||
    m['notices'].some((p) => typeof p !== 'string' || names.get(p)?.type !== 'file')
  )
    cefError('BAD_MANIFEST', 'Missing preserved runtime notices')
  return { ...structuredClone(m), identity } as unknown as CefRuntimeManifest
}
export function verifyCefManifest(
  envelope: SignedManifest,
  roots: Readonly<Record<string, string>>,
  expected: CefRuntimeIdentity
): CefRuntimeManifest {
  if (!envelope || typeof envelope.keyId !== 'string' || !Object.hasOwn(roots, envelope.keyId))
    cefError('UNTRUSTED_KEY', 'Unknown runtime signing key')
  const decode = (v: unknown, max: number) => {
    if (
      typeof v !== 'string' ||
      v.length > max * 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)
    )
      cefError('BAD_MANIFEST', 'Invalid runtime envelope encoding')
    const b = Buffer.from(v as string, 'base64')
    if (b.length > max) cefError('BAD_MANIFEST', 'Oversized runtime envelope')
    return b
  }
  const payload = decode(envelope.payload, 4 * 1024 * 1024),
    signature = decode(envelope.signature, 64),
    key = createPublicKey(roots[envelope.keyId]!)
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    signature.length !== 64 ||
    !verify(null, payload, key, signature)
  )
    cefError('BAD_SIGNATURE', 'Runtime manifest authentication failed')
  const result = parseCefManifest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
    ),
    wanted = cefIdentity(expected)
  for (const k of Object.keys(wanted) as (keyof CefRuntimeIdentity)[])
    if (wanted[k] !== result.identity[k])
      cefError('IDENTITY_MISMATCH', `Runtime ${k} does not match the selected prebuild`)
  return result
}

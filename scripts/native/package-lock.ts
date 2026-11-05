import { isDeepStrictEqual } from 'node:util'
import { packagePath } from './paths.ts'

type LockedPackage = [string, string, Record<string, unknown>, string]
export type DependencyLock = {
  lockfileVersion: 2
  configVersion: 1
  packages: Record<string, LockedPackage>
}
type ArchiveInfo = { dependencies?: Record<string, string>; bin?: Record<string, string> }
export type LocalArchiveLock = {
  packages: Record<string, [string, ArchiveInfo, string]>
  overrides: Record<string, string>
}

/** Pinned Bun text locks use raw tarball paths; file: denotes a folder in this field. */
export function localArchiveLock(
  archives: readonly {
    name: string
    file: string
    sha256: string
    dependencies?: Record<string, string>
    bin?: Record<string, string>
  }[]
): LocalArchiveLock {
  const packages: LocalArchiveLock['packages'] = Object.create(null)
  const overrides: Record<string, string> = Object.create(null)
  for (const archive of archives) {
    if (
      !archive.name.startsWith('@bun-native/') ||
      !packagePath(archive.file) ||
      !archive.file.endsWith('.tgz') ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) ||
      Object.hasOwn(packages, archive.name)
    )
      throw new Error(`Invalid or duplicate local archive lock input: ${archive.name}`)
    const info: ArchiveInfo = {
      ...(archive.dependencies ? { dependencies: archive.dependencies } : {}),
      ...(archive.bin ? { bin: archive.bin } : {}),
    }
    packages[archive.name] = [
      `${archive.name}@${archive.file}`,
      info,
      `sha256-${Buffer.from(archive.sha256, 'hex').toString('base64')}`,
    ]
    overrides[archive.name] = `file:${archive.file}`
  }
  return {
    packages: Object.fromEntries(Object.entries(packages)),
    overrides: Object.fromEntries(Object.entries(overrides)),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid dependency lock record')
  return value as Record<string, unknown>
}

export function lockedPackages(value: unknown, local?: LocalArchiveLock): DependencyLock {
  const lock = record(value)
  if (lock['lockfileVersion'] !== 2 || lock['configVersion'] !== 1)
    throw new Error('Expected the pinned Bun dependency lock format')
  const supplied = record(lock['packages'])
  if (local)
    for (const [name, expected] of Object.entries(local.packages))
      if (!Object.hasOwn(supplied, name) || !isDeepStrictEqual(supplied[name], expected))
        throw new Error(`Installed local archive lock differs: ${name}`)
  const packages: DependencyLock['packages'] = Object.create(null)
  for (const [key, value] of Object.entries(supplied)) {
    if (local && Object.hasOwn(local.packages, key)) continue
    if (!Array.isArray(value) || typeof value[0] !== 'string')
      throw new Error(`Invalid locked package: ${key}`)
    if (value[0].includes('@workspace:') || value[0].includes('@file:')) {
      if (local || !key.startsWith('@bun-native/') || value[0].includes('@file:'))
        throw new Error(`Unexpected local dependency in lock: ${key}`)
      continue
    }
    if (
      value.length !== 4 ||
      value[1] !== '' ||
      typeof value[3] !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value[3])
    )
      throw new Error(`Expected an integrity-bound registry dependency: ${key}`)
    packages[key] = [value[0], value[1], record(value[2]), value[3]]
  }
  return {
    lockfileVersion: 2,
    configVersion: 1,
    packages: Object.fromEntries(Object.entries(packages)),
  }
}

function identity(entry: LockedPackage): { name: string; version: string } {
  const separator = entry[0].lastIndexOf('@')
  const name = entry[0].slice(0, separator)
  const version = entry[0].slice(separator + 1)
  if (separator <= 0 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Expected an exact registry version: ${entry[0]}`)
  return { name, version }
}

/** Preserve nested resolutions; a global name override would collapse distinct versions. */
export function dependencyClosure(
  lock: DependencyLock,
  roots: Record<string, string>,
  includeInstalledOptionalPeers = false
): DependencyLock {
  const packages: DependencyLock['packages'] = Object.create(null)
  const pending: string[] = []
  for (const [name, version] of Object.entries(roots)) {
    const entry = Object.hasOwn(lock.packages, name) ? lock.packages[name] : undefined
    if (!entry || identity(entry).name !== name || identity(entry).version !== version)
      throw new Error(`Source lock does not pin ${name}@${version}`)
    pending.push(name)
  }
  const resolve = (from: string, name: string, required: boolean): string | undefined => {
    let ancestor = from
    while (ancestor) {
      const candidate = `${ancestor}/${name}`
      if (Object.hasOwn(lock.packages, candidate)) return candidate
      const current = Object.hasOwn(lock.packages, ancestor) ? lock.packages[ancestor] : undefined
      if (!current || !ancestor.endsWith(identity(current).name))
        throw new Error(`Invalid nested dependency locator: ${ancestor}`)
      ancestor = ancestor.slice(0, -identity(current).name.length).replace(/\/$/, '')
    }
    if (Object.hasOwn(lock.packages, name)) return name
    if (required) throw new Error(`Source lock is missing ${name}, required by ${from}`)
    return undefined
  }
  for (let index = 0; index < pending.length; index += 1) {
    const key = pending[index]!
    if (packages[key]) continue
    const entry = lock.packages[key]!
    identity(entry)
    packages[key] = entry
    const optionalPeers = entry[2]['optionalPeers'] ?? []
    if (!Array.isArray(optionalPeers) || optionalPeers.some((name) => typeof name !== 'string'))
      throw new Error(`Invalid optional peer metadata: ${key}`)
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const dependencies = entry[2][field]
      if (dependencies === undefined) continue
      for (const [name, version] of Object.entries(record(dependencies))) {
        if (typeof version !== 'string') throw new Error(`Invalid ${key} dependency ${name}`)
        // Optional peer declarations remain byte-identical in the retained
        // tuple. They do not add an installation root that the source lacked.
        const optionalPeer = field === 'peerDependencies' && optionalPeers.includes(name)
        if (optionalPeer && !includeInstalledOptionalPeers) continue
        const target = resolve(key, name, !optionalPeer && field !== 'optionalDependencies')
        if (target) pending.push(target)
      }
    }
  }
  return {
    lockfileVersion: 2,
    configVersion: 1,
    packages: Object.fromEntries(
      Object.entries(packages).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    ),
  }
}

/** Keep a complete lock graph; Bun rejects missing local roots before installation. */
export function seedConsumerLock(
  lock: DependencyLock,
  manifest: {
    name: string
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  },
  local: LocalArchiveLock = { packages: {}, overrides: {} }
) {
  const packages = { ...lock.packages, ...local.packages }
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
    if (!Object.hasOwn(packages, name))
      throw new Error(`Consumer lock is missing a root package: ${name}`)
  return {
    lockfileVersion: lock.lockfileVersion,
    configVersion: lock.configVersion,
    workspaces: { '': manifest },
    overrides: local.overrides,
    packages,
  }
}

/** No new tuple, changed version/integrity/edge, or omitted required nested tuple is accepted. */
export function verifyConsumerLock(
  value: unknown,
  expected: DependencyLock,
  allowAdditional = false,
  local?: LocalArchiveLock
): void {
  // Applications may add unrelated dependencies. The fixed qualification cohort
  // uses the exact comparison; runtime validation still pins every required tuple.
  const packages = record(record(value)['packages'])
  const localRoots = Object.keys(local?.packages ?? {})
  if (Object.keys(packages).some((key) => localRoots.some((root) => key.startsWith(root + '/'))))
    throw new Error(
      'Installed dependency lock introduces a nested locator beneath a required local package'
    )
  const supplied = lockedPackages(value, local)
  const roots = Object.fromEntries(
    Object.entries(expected.packages)
      .filter(([key, entry]) => key === identity(entry).name)
      .map(([key, entry]) => [key, identity(entry).version])
  )
  const actual = allowAdditional ? dependencyClosure(supplied, roots, true) : supplied
  if (!isDeepStrictEqual(actual, expected))
    throw new Error('Installed dependency lock differs from the supplied pinned package set')
  if (local) {
    const overrides = record(record(value)['overrides'])
    // Selector/parent override forms can affect required packages too. Keep the
    // complete override map exact, while permitting unrelated registry roots.
    if (!isDeepStrictEqual(overrides, local.overrides))
      throw new Error(
        'Installed local archive overrides differ from the supplied pinned package set'
      )
  }
}

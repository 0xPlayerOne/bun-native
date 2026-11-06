import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LIMITS,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'

const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

const snake = (name: string): string => name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_').toLowerCase()

/** Every capability name the TypeScript protocol accepts, in declaration order. */
function typescriptCapabilities(): string[] {
  const source = read('packages/protocol/src/messages.ts')
  const block = (pattern: RegExp): string => {
    const match = source.match(pattern)?.[1]
    if (match === undefined) throw new Error(`messages.ts no longer matches ${pattern}`)
    return match
  }
  const names = (text: string): string[] => [...text.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!)
  const optional = names(block(/\nconst CAPABILITIES = \[\n([\s\S]*?)\n\] as const/))
  return [...REQUIRED_CAPABILITIES, ...optional]
}

/** The Rust `Capability` enum variants, serialized as serde's snake_case. */
function rustCapabilities(): string[] {
  const enumBody = read('native/protocol/src/wire.rs').match(
    /#\[serde\(rename_all = "snake_case"\)\]\npub enum Capability \{\n([\s\S]*?)\n\}/
  )?.[1]
  if (enumBody === undefined) throw new Error('wire.rs no longer declares a snake_case Capability')
  return [...enumBody.matchAll(/^\s+([A-Z][A-Za-z0-9]*),$/gm)].map((m) => snake(m[1]!))
}

/** What the host's `hello` handler advertises unconditionally, and behind a condition. */
function hostAdvertisement(): { always: Set<string>; conditional: Set<string> } {
  const session = read('native/gpui-host/src/session.rs')
  const start = session.indexOf('let mut capabilities = vec![')
  const end = session.indexOf('self.events.send(', start)
  if (start < 0 || end < 0) throw new Error('session.rs no longer builds a capability list')
  const lines = session.slice(start, end).split('\n')
  const always = new Set<string>()
  const conditional = new Set<string>()
  let inInitial = true
  let depth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (inInitial) {
      for (const match of trimmed.matchAll(/Capability::([A-Za-z0-9]+)/g))
        always.add(snake(match[1]!))
      if (trimmed === '];') inInitial = false
      continue
    }
    const pushed = trimmed.match(/^capabilities\.push\(Capability::([A-Za-z0-9]+)\);$/)?.[1]
    if (pushed !== undefined) (depth > 0 ? conditional : always).add(snake(pushed))
    depth += (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length
  }
  return { always, conditional }
}

interface PlatformRow {
  capability: string
  linux: string
  macos: string
  windows: string
}

/** The capability table in docs/native-platforms.md. */
function documentedPlatforms(): PlatformRow[] {
  const heading = '## Advertised capabilities by platform'
  const markdown = read('docs/native-platforms.md')
  const start = markdown.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`docs/native-platforms.md has no "${heading}" section`)
  const body = markdown.slice(start + heading.length + 2)
  const section = body.slice(0, body.search(/\n## /))
  const rows: PlatformRow[] = []
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    const capability = cells[1]?.match(/^`([a-z0-9_]+)`$/)?.[1]
    if (capability === undefined) continue
    rows.push({ capability, linux: cells[2]!, macos: cells[3]!, windows: cells[4]! })
  }
  return rows
}

describe('capability names agree across languages and documentation', () => {
  const names = typescriptCapabilities()

  test('the TypeScript and Rust capability lists are identical and duplicate-free', () => {
    expect(new Set(names).size).toBe(names.length)
    expect(rustCapabilities()).toEqual(names)
  })

  test('readiness accepts exactly the extracted list, and nothing beyond it', () => {
    const ready = (capabilities: string[]) =>
      parseEvent({
        type: 'ready',
        protocol: PROTOCOL_VERSION,
        capabilities,
        limits: DEFAULT_LIMITS,
        service_policy: {
          window_display: false,
          clipboard_read: false,
          clipboard_write: false,
          global_shortcuts: false,
          notifications: false,
          drag_drop: false,
          filesystem_roots: [],
          processes: [],
        },
      })
    expect(ready(names)).toMatchObject({ capabilities: names })
    expect(() => ready([...names, 'shell_exec_v1'])).toThrow()
    expect(() => ready([...names.slice(1), names[1]!])).toThrow()
  })

  test('the host advertises every capability, each from one place', () => {
    const { always, conditional } = hostAdvertisement()
    for (const name of always) expect(conditional.has(name)).toBe(false)
    expect([...always, ...conditional].sort()).toEqual([...names].sort())
    for (const required of REQUIRED_CAPABILITIES) expect(always.has(required)).toBe(true)
  })

  test('the platform table lists every capability once and matches the unconditional set', () => {
    const rows = documentedPlatforms()
    const listed = rows.map((row) => row.capability)
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed.sort()).toEqual([...names].sort())
    const { always } = hostAdvertisement()
    const everywhere = rows
      .filter((row) => [row.linux, row.macos, row.windows].every((cell) => cell === 'Always'))
      .map((row) => row.capability)
    expect(everywhere.sort()).toEqual([...always].sort())
  })

  test('display details and changes follow the macOS/Windows compile-time selection', () => {
    const services = read('native/gpui-host/src/services.rs')
    const rows = new Map(documentedPlatforms().map((row) => [row.capability, row]))
    for (const [constant, capability] of [
      ['DISPLAY_DETAILS', 'display_details_v1'],
      ['DISPLAY_CHANGES', 'display_changes_v1'],
    ] as const) {
      expect(services).toContain(
        `pub(crate) const ${constant}: bool = cfg!(any(target_os = "macos", target_os = "windows"));`
      )
      expect(rows.get(capability)).toMatchObject({
        linux: 'Never',
        macos: 'Always',
        windows: 'Always',
      })
    }
  })

  test('every backticked capability-like name in the docs is a real capability', () => {
    const known = new Set(names)
    const documents = [
      'README.md',
      'tests/native/README.md',
      ...readdirSync(join(root, 'docs'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => `docs/${name}`),
      ...readdirSync(join(root, 'docs', 'decisions'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => `docs/decisions/${name}`),
    ]
    const unknown: string[] = []
    for (const document of documents)
      for (const match of read(document).matchAll(/`([a-z][a-z0-9_]*_v[0-9]+)`/g))
        if (!known.has(match[1]!)) unknown.push(`${document}: ${match[1]}`)
    expect(unknown).toEqual([])
  })

  test('the service and platform docs name every capability', () => {
    const docs = read('docs/native-services.md') + read('docs/native-platforms.md')
    for (const name of names) expect(docs).toContain(`\`${name}\``)
  })
})

describe('the current protocol version is stated consistently', () => {
  const version = String(PROTOCOL_VERSION)

  test('Rust and TypeScript agree', () => {
    expect(read('native/protocol/src/wire.rs')).toMatch(
      new RegExp(`^pub const PROTOCOL_VERSION: u32 = ${version};$`, 'm')
    )
  })

  test('every shared wire fixture names the current protocol', () => {
    const stale: string[] = []
    for (const name of readdirSync(join(root, 'tests', 'fixtures'))) {
      if (!name.endsWith('.json')) continue
      const fixture: unknown = JSON.parse(read(`tests/fixtures/${name}`))
      if (fixture === null || typeof fixture !== 'object' || !('protocol' in fixture)) continue
      if (fixture.protocol !== PROTOCOL_VERSION) stale.push(`${name}: ${String(fixture.protocol)}`)
    }
    expect(stale).toEqual([])
  })

  test.each([
    ['docs/native-abi.md', /^# Native host protocol (\d+)$/m],
    ['docs/decisions/README.md', /\[Native host protocol (\d+)\]/],
    ['docs/architecture.md', /^Protocol (\d+) requires/m],
    ['packages/core/README.md', /^Protocol (\d+) requires/m],
    ['docs/native-services.md', /the current protocol (\d+)/],
    ['docs/README.md', /through the current protocol (\d+)/],
    ['docs/decisions/0004-public-api.md', /owned drop targets to protocol (\d+)/],
  ] as const)('%s names the current protocol', (path, pattern) => {
    expect(read(path).match(pattern)?.[1]).toBe(version)
  })
})

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  DECORATION_FIELDS,
  DEFAULT_LIMITS,
  ERROR_CODES,
  parseCommand,
  parseElement,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from '@bun-native/protocol'
import {
  main,
  readSchema,
  render,
  renderRust,
  renderTypeScript,
  resolveSchema,
  RUST_PATH,
  SCHEMA_PATH,
  TYPESCRIPT_PATH,
  type Schema,
} from '../../scripts/protocol/schema.ts'

const root = resolve(import.meta.dir, '../..')
const schema = readSchema(root)
const roots: string[] = []

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A checkout holding only the schema and the formatter settings. */
function checkout(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wire-schema-'))
  roots.push(directory)
  for (const path of [SCHEMA_PATH, '.oxfmtrc.json']) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    cpSync(join(root, path), join(directory, path))
  }
  for (const path of [TYPESCRIPT_PATH, RUST_PATH])
    mkdirSync(dirname(join(directory, path)), { recursive: true })
  return directory
}

/** The checked-in schema with one part replaced, before resolution. */
function variant(change: (raw: Schema) => void): Schema {
  const raw = JSON.parse(readFileSync(join(root, SCHEMA_PATH), 'utf8')) as Schema
  change(raw)
  return raw
}

describe('generated wire schema', () => {
  test('the committed TypeScript and Rust files are current', () => {
    for (const [path, text] of render(root))
      expect(readFileSync(join(root, path), 'utf8')).toBe(text)
    expect(main(['--check'], root)).toBe(0)
  })

  test('writes missing files, then reports a stale one without writing it', () => {
    const directory = checkout()
    expect(main([], directory)).toBe(0)
    expect(main(['--check'], directory)).toBe(0)
    writeFileSync(join(directory, RUST_PATH), '// edited\n')
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(main(['--check'], directory)).toBe(1)
      expect(error.mock.calls[0]?.[0]).toContain(RUST_PATH)
    } finally {
      error.mockRestore()
    }
    expect(readFileSync(join(directory, RUST_PATH), 'utf8')).toBe('// edited\n')
    expect(main([], directory)).toBe(0)
    expect(main(['--check'], directory)).toBe(0)
  })

  test('the parsers read the schema the files were generated from', () => {
    const constant = (name: string) => schema.constants.find((entry) => entry.name === name)!.value
    expect(PROTOCOL_VERSION).toBe(constant('PROTOCOL_VERSION') as typeof PROTOCOL_VERSION)
    expect(Object.keys(DEFAULT_LIMITS)).toEqual(schema.limits.map((name) => name.toLowerCase()))
    for (const name of schema.limits)
      expect(DEFAULT_LIMITS[name.toLowerCase() as keyof typeof DEFAULT_LIMITS]).toBe(constant(name))
    expect<readonly string[]>(ERROR_CODES).toEqual(schema.enums['ErrorCode']!.values as string[])
    expect<readonly string[]>(REQUIRED_CAPABILITIES).toEqual(
      schema.enums['Capability']!.values.flatMap((value) =>
        typeof value !== 'string' && value.required ? [value.name] : []
      )
    )
    expect<readonly string[]>(DECORATION_FIELDS).toEqual(
      schema.style.filter((field) => field.decoration).map((field) => field.name)
    )
  })

  test('every style field accepts its range and rejects the value beyond it', () => {
    for (const field of schema.style) {
      const box = (value: unknown) => parseElement({ kind: 'box', style: { [field.name]: value } })
      switch (field.type) {
        case 'enum':
          for (const value of schema.enums[field.enum]!.values)
            if (field.name !== 'scroll_anchor') box(typeof value === 'string' ? value : value.name)
          expect(() => box('unknown')).toThrow(field.name + ' must be one of')
          break
        case 'color':
          expect(box(0xff_ffff).style).toEqual({ [field.name]: 0xff_ffff })
          expect(() => box(0x100_0000)).toThrow(field.name)
          break
        case 'dimension':
        case 'number':
          if (field.type === 'dimension')
            expect(box('fill').style).toEqual({ [field.name]: 'fill' })
          expect(box(field.max).style).toEqual({ [field.name]: field.max })
          expect(() => box(field.max + 1)).toThrow(field.name)
          expect(() => box(field.min - 1)).toThrow(field.name)
          break
        case 'weight':
          expect(box(field.min + field.step).style).toEqual({
            [field.name]: field.min + field.step,
          })
          expect(() => box(field.min + field.step / 2)).toThrow('multiple of ' + field.step)
          expect(() => box(field.max + field.step)).toThrow(field.name)
      }
    }
    expect(() => parseElement({ kind: 'box', style: { margin: 1 } })).toThrow(
      'Unknown message property: margin'
    )
  })

  test('every message rejects a member outside its schema list before reading the others', () => {
    const unknown = 'Unknown message property: __probe'
    for (const type of Object.keys(schema.events))
      expect(() => parseEvent({ type, __probe: 0 })).toThrow(unknown)
    for (const type of Object.keys(schema.commands))
      expect(() => parseCommand({ id: 1, type, __probe: 0 })).toThrow(unknown)
    for (const type of Object.keys(schema.operations))
      expect(() =>
        parseCommand({
          id: 1,
          type: 'batch',
          window_id: 1,
          base_revision: 0,
          operations: [{ type, __probe: 0 }],
        })
      ).toThrow(unknown)
    for (const kind of Object.keys(schema.elements))
      expect(() => parseElement({ kind, __probe: 0 })).toThrow(unknown)
  })
})

describe('schema validation', () => {
  test.each<[string, (raw: Schema) => void, string]>([
    ['duplicate constants', (raw) => raw.constants.push({ ...raw.constants[0]! }), 'repeats'],
    ['lower-case constants', (raw) => raw.constants.push({ name: 'max', value: 1 }), 'upper case'],
    ['fractional integers', (raw) => raw.constants.push({ name: 'HALF', value: 0.5 }), 'integer'],
    ['unknown limits', (raw) => raw.limits.push('MAX_NOTHING'), 'not a constant'],
    ['non-usize limits', (raw) => raw.limits.push('MAX_SCROLL_OFFSET'), 'usize'],
    ['enum names', (raw) => (raw.enums['bad'] = { values: ['a'] }), 'PascalCase'],
    ['empty enums', (raw) => (raw.enums['Empty'] = { values: [] }), 'no values'],
    ['enum values', (raw) => (raw.enums['Bad'] = { values: ['Bad'] }), 'snake_case'],
    ['enum duplicates', (raw) => (raw.enums['Twice'] = { values: ['a', 'a'] }), 'repeats'],
    [
      'enum defaults',
      (raw) => (raw.enums['Defaulted'] = { values: ['a'], default: 'b' }),
      'not a value',
    ],
    [
      'required order',
      (raw) => (raw.enums['Late'] = { values: ['a', { name: 'b', required: true }] }),
      'required values first',
    ],
    ['style names', (raw) => raw.style.push({ name: 'Bad', type: 'color' }), 'snake_case'],
    ['style duplicates', (raw) => raw.style.push({ name: 'gap', type: 'color' }), 'repeats'],
    [
      'style enums',
      (raw) => raw.style.push({ name: 'mode', type: 'enum', enum: 'Missing' }),
      'unknown enum',
    ],
    [
      'style ranges',
      (raw) => raw.style.push({ name: 'inverted', type: 'number', min: 2, max: 1 }),
      'min > max',
    ],
    ['modifier duplicates', (raw) => raw.modifiers.push('alt'), 'repeats'],
    ['group members', (raw) => (raw.groups['bad'] = ['Bad']), 'snake_case'],
    ['unknown groups', (raw) => (raw.commands['ping'] = ['@missing']), 'unknown group'],
    ['member names', (raw) => (raw.events['ping'] = ['Bad']), 'snake_case'],
    ['member duplicates', (raw) => (raw.events['ping'] = ['id', 'id']), 'repeats'],
    ['tag names', (raw) => (raw.operations['Bad'] = []), 'snake_case'],
    [
      'member masks',
      (raw) => (raw.elements['wide'] = Array.from({ length: 32 }, (_, index) => `member_${index}`)),
      '32-bit member mask',
    ],
    [
      'tag masks',
      (raw) => {
        for (let index = 0; index < 33; index++) raw.operations[`op_${index}`] = []
      },
      '32-bit member mask',
    ],
  ])('rejects %s', (_name, change, message) => {
    expect(() => resolveSchema(variant(change))).toThrow(message)
  })

  test('renders floats, defaults and required values in both languages', () => {
    const custom = resolveSchema(
      variant((raw) => {
        raw.constants.push({ name: 'RATIO', value: 0.25, rust: 'f64', doc: 'A ratio.' })
        raw.enums['Mode'] = {
          values: [{ name: 'on', required: true }, 'off'],
          ts: 'MODES',
          default: 'off',
        }
      })
    )
    const rust = renderRust(custom)
    expect(rust).toContain('/// A ratio.\npub const RATIO: f64 = 0.25;')
    expect(rust).toContain('pub enum Mode {\n    On,\n    #[default]\n    Off,\n}')
    const typescript = renderTypeScript(custom)
    expect(typescript).toContain('/** A ratio. */\nexport const RATIO = 0.25')
    expect(typescript).toContain("export const REQUIRED_MODES = Object.freeze([\n  'on',\n]")
    expect(typescript).toContain('export const MODES = Object.freeze([\n  ...REQUIRED_MODES,')
  })
})

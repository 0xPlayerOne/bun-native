import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectDiagnosticBundle,
  redactDiagnosticValue,
  renderSourceMappedFrame,
  type DiagnosticRecord,
  type DiagnosticSourceMap,
} from '../packages/runtime/src/diagnostics.ts'

describe('bounded diagnostic snapshots', () => {
  test('accounts for the complete UTF-8 JSON envelope when admission truncates', () => {
    const bundle = collectDiagnosticBundle(
      Array.from({ length: 20 }, () => ({ kind: 'renderer-log' as const, message: '🐙 café' })),
      { maxBytes: 120 }
    )
    expect(bundle.truncated).toBe(true)
    expect(bundle.bytes).toBe(Buffer.byteLength(JSON.stringify(bundle), 'utf8'))
    expect(bundle.bytes).toBeLessThanOrEqual(120)
  })

  test('redacts home identities and credentials in every retained field', () => {
    const bundle = collectDiagnosticBundle(
      [
        {
          kind: 'bun-error',
          message: 'failed in /Users/private-user/project/index.ts',
          at: 'token=private-secret',
          frame: { file: 'C:\\Users\\private-user\\project\\index.ts', line: 3, column: 2 },
        },
      ],
      { maxBytes: 4096 }
    )
    const wire = JSON.stringify(bundle)
    expect(wire).not.toContain('private-user')
    expect(wire).not.toContain('private-secret')
  })

  test('does not invoke diagnostic record accessors', () => {
    let reads = 0
    const record = Object.defineProperty({ kind: 'renderer-log' as const }, 'message', {
      enumerable: true,
      get() {
        reads++
        return 'secret getter content'
      },
    })
    const bundle = collectDiagnosticBundle([record as never], { maxBytes: 4096 })
    expect(reads).toBe(0)
    expect(bundle.records).toEqual([])
    expect(bundle.truncated).toBe(true)
  })

  test('represents cyclic input without recursion or callbacks', () => {
    const value: Record<string, unknown> = { safe: 'value' }
    value['self'] = value
    expect(redactDiagnosticValue(value, { maxBytes: 4096 })).toEqual({
      safe: 'value',
      self: '[circular]',
    })
  })

  test('uses real v3 segments and original positions, rather than sources[0]', () => {
    const sourceMap = {
      version: 3 as const,
      file: 'generated.js',
      sources: ['wrong.ts', 'original.ts'],
      names: [],
      mappings: 'KCIU',
    }
    expect(
      renderSourceMappedFrame({ file: 'generated.js', line: 1, column: 6 }, sourceMap)
    ).toEqual({
      file: 'original.ts',
      line: 5,
      column: 11,
    })
  })

  test('preserves the complete byte bound at empty and UTF-8/digit boundaries', () => {
    for (const maxBytes of [64, 99, 100, 101, 999, 1000, 1024, 4096]) {
      for (const records of [
        [],
        Array.from({ length: 100 }, (_, index) => ({
          kind: 'renderer-log' as const,
          message: `café 🐙 \\ " ${index}`,
        })),
      ]) {
        const bundle = collectDiagnosticBundle(records, { maxBytes })
        expect(bundle.bytes).toBe(Buffer.byteLength(JSON.stringify(bundle), 'utf8'))
        expect(bundle.bytes).toBeLessThanOrEqual(maxBytes)
        expect(Object.isFrozen(bundle)).toBe(true)
        expect(Object.isFrozen(bundle.records)).toBe(true)
      }
    }
  })

  test('captures only the declared fields and never calls input toJSON or iterators', () => {
    let reads = 0
    const record = {
      kind: 'renderer-log' as const,
      message: 'ordinary event',
      private: 'must not be copied',
      toJSON() {
        reads++
        return { message: 'must not be serialized' }
      },
    }
    const records = [record]
    Object.defineProperty(records, Symbol.iterator, {
      get() {
        reads++
        throw new Error('iterator')
      },
    })
    const bundle = collectDiagnosticBundle(records, { maxBytes: 4096 })
    expect(reads).toBe(0)
    expect(bundle.records).toEqual([{ kind: 'renderer-log', message: 'ordinary event' }])
    expect(bundle.truncated).toBe(false)
    expect(Object.isFrozen(bundle.records[0])).toBe(true)
    record.message = 'later edit'
    expect(bundle.records[0]!.message).toBe('ordinary event')
  })

  test('bounds record traversal before inspecting an oversized or sparse input', () => {
    let reads = 0
    const records: DiagnosticRecord[] = Array.from({ length: 256 }, () => ({
      kind: 'rpc-stage',
      message: 'accepted',
    }))
    Object.defineProperty(records, 256, {
      get() {
        reads++
        throw new Error('past bound')
      },
    })
    records.length = 100_000_000
    const bundle = collectDiagnosticBundle(records, { maxBytes: 1024 * 1024 })
    expect(reads).toBe(0)
    expect(bundle.records).toHaveLength(256)
    expect(bundle.truncated).toBe(true)
  })

  test('omits record-list and optional-field accessors without running them', () => {
    let reads = 0
    const records: DiagnosticRecord[] = []
    Object.defineProperty(records, 0, {
      get() {
        reads++
        throw new Error('record')
      },
    })
    const record = { kind: 'bun-error', message: 'ordinary failure' }
    for (const key of ['at', 'frame'])
      Object.defineProperty(record, key, {
        enumerable: true,
        get() {
          reads++
          throw new Error(key)
        },
      })
    records.push(record as DiagnosticRecord)
    const bundle = collectDiagnosticBundle(records, { maxBytes: 4096 })
    expect(reads).toBe(0)
    expect(bundle.records).toEqual([{ kind: 'bun-error', message: 'ordinary failure' }])
    expect(bundle.truncated).toBe(true)
  })

  test('refuses proxies without invoking their traps', () => {
    let traps = 0
    const proxy = new Proxy(
      {},
      {
        get() {
          traps++
          throw new Error('get')
        },
        getOwnPropertyDescriptor() {
          traps++
          throw new Error('descriptor')
        },
        getPrototypeOf() {
          traps++
          throw new Error('prototype')
        },
        ownKeys() {
          traps++
          throw new Error('keys')
        },
      }
    )
    expect(redactDiagnosticValue(proxy, { maxBytes: 4096 })).toBe('[unavailable]')
    expect(collectDiagnosticBundle([proxy as DiagnosticRecord], { maxBytes: 4096 }).truncated).toBe(
      true
    )
    expect(() =>
      collectDiagnosticBundle(new Proxy([], {}) as DiagnosticRecord[], { maxBytes: 4096 })
    ).toThrow(TypeError)
    expect(traps).toBe(0)
  })

  test('rejects invalid budgets and never coerces policy values', () => {
    for (const maxBytes of [0, -1, 63, 64.5, NaN, Infinity, 1048577])
      expect(() => collectDiagnosticBundle([], { maxBytes })).toThrow(TypeError)
    let reads = 0
    const policy = Object.defineProperty({}, 'maxBytes', {
      get() {
        reads++
        return 4096
      },
    })
    expect(() => collectDiagnosticBundle([], policy as never)).toThrow(TypeError)
    expect(reads).toBe(0)
    for (const redaction of ['', 'x'.repeat(33), '\n'])
      expect(() => collectDiagnosticBundle([], { maxBytes: 4096, redaction })).toThrow(TypeError)
  })

  test('bounds oversized text without exposing a partial secret', () => {
    const bundle = collectDiagnosticBundle(
      [{ kind: 'renderer-log', message: 'x'.repeat(8192) + 'token=private-value' }],
      { maxBytes: 4096 }
    )
    expect(bundle.records[0]!.message).toBe('[truncated]')
    expect(bundle.truncated).toBe(true)
    expect(JSON.stringify(bundle)).not.toContain('private-value')
  })

  test('redacts embedded POSIX, Windows and file-URL home paths', () => {
    for (const path of [
      '/Users/Private Person/project/main.ts',
      '/home/private-user/project/main.ts',
      '/root/project/main.ts',
      'C:\\Users\\Private Person\\project\\main.ts',
      'c:\\users\\private-user\\project\\main.ts',
      'file:///Users/private-user/project/main.ts',
    ]) {
      const value = String(redactDiagnosticValue(`failed at ${path}`, { maxBytes: 4096 }))
      expect(value).not.toContain('private-user')
      expect(value).not.toContain('Private Person')
      expect(value).toContain('~/')
    }
    expect(redactDiagnosticValue('https://user:pwd@example.test/file', { maxBytes: 4096 })).toBe(
      '[redacted]'
    )
    expect(redactDiagnosticValue('pass\u0000word=private-value', { maxBytes: 4096 })).toBe(
      '[redacted]'
    )
  })

  test('bounds nested redaction, unsupported values and final encoded bytes', () => {
    let value: unknown = 'leaf'
    for (let depth = 0; depth < 100; depth++) value = { child: value }
    expect(JSON.stringify(redactDiagnosticValue(value, { maxBytes: 4096 }))).toContain(
      '[truncated]'
    )
    const wide = Array.from({ length: 1000 }, () => 'data')
    expect(JSON.stringify(redactDiagnosticValue(wide, { maxBytes: 64 }))).toBe('"[truncated]"')
    expect(
      redactDiagnosticValue([undefined, NaN, Infinity, 1n, Symbol('private')], { maxBytes: 4096 })
    ).toEqual(Array(5).fill('[unavailable]'))
    let reads = 0
    const object = Object.defineProperty({ safe: 'visible' }, 'reader', {
      enumerable: true,
      get() {
        reads++
        throw new Error('reader')
      },
    })
    expect(redactDiagnosticValue(object, { maxBytes: 4096 })).toEqual({
      safe: 'visible',
      reader: '[unavailable]',
    })
    expect(reads).toBe(0)
  })

  test('does not expose values behind redacted or normalized credential keys', () => {
    const result = redactDiagnosticValue(
      {
        'pass\u0000word': 'private-value',
        'https://user:pwd@example.test': 'private-url-value',
        ['x'.repeat(8193)]: 'private-long-key-value',
      },
      { maxBytes: 4096 }
    )
    expect(JSON.stringify(result)).not.toContain('private-')
  })

  test('preserves captured positions for unusable, foreign or unmapped source maps', () => {
    const frame = { file: 'generated.js', line: 1, column: 1 }
    const map: DiagnosticSourceMap = {
      version: 3,
      file: 'generated.js',
      sources: ['original.ts'],
      mappings: 'KAAA',
    }
    for (const sourceMap of [
      undefined,
      { ...map, file: 'another.js' },
      { ...map, version: 2 },
      { ...map, mappings: '!' },
      { ...map, sources: [] },
      { sources: ['wrong.ts'], mappings: 'AAAA' },
      map,
    ])
      expect(renderSourceMappedFrame(frame, sourceMap as DiagnosticSourceMap | undefined)).toEqual(
        frame
      )
    const later = { ...frame, line: 2, column: 20 }
    expect(renderSourceMappedFrame(later, { ...map, mappings: 'AAAA;' })).toEqual(later)
    expect(renderSourceMappedFrame({ ...frame, column: 99 }, { ...map, mappings: 'AAAA' })).toEqual(
      {
        ...frame,
        file: 'original.ts',
      }
    )
  })

  test('does not inspect source-map accessors or embedded source content', () => {
    let reads = 0
    const sourceMap = {
      version: 3 as const,
      file: 'generated.js',
      sources: ['original.ts'],
      mappings: 'AAAA',
    }
    Object.defineProperty(sourceMap, 'sourcesContent', {
      get() {
        reads++
        throw new Error('source code')
      },
    })
    expect(
      renderSourceMappedFrame({ file: 'generated.js', line: 1, column: 1 }, sourceMap)
    ).toEqual({
      file: 'original.ts',
      line: 1,
      column: 1,
    })
    Object.defineProperty(sourceMap, 'mappings', {
      get() {
        reads++
        throw new Error('map')
      },
    })
    const frame = { file: 'generated.js', line: 1, column: 1 }
    expect(renderSourceMappedFrame(frame, sourceMap)).toEqual(frame)
    expect(reads).toBe(0)
  })

  test('resolves a map produced by the pinned Bun bundler and redacts the mapped path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunly-diagnostics-'))
    try {
      const entry = join(directory, 'original.ts')
      await writeFile(
        entry,
        '\n\n\nexport function fail() {\n  throw new Error("MAPPED_FAILURE")\n}\n'
      )
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: join(directory, 'out'),
        target: 'bun',
        format: 'esm',
        minify: true,
        sourcemap: 'external',
      })
      expect(result.success).toBe(true)
      const script = result.outputs.find((output) => output.kind === 'entry-point')!
      const generated = await script.text()
      // Bun's map need not include optional v3 file metadata. Bind the supplied map
      // to the actual build output explicitly; the collector never guesses a path.
      const sourceMap = {
        ...JSON.parse(await readFile(script.path + '.map', 'utf8')),
        file: script.path,
      } as DiagnosticSourceMap
      const offset = generated.indexOf('throw')
      expect(offset).toBeGreaterThanOrEqual(0)
      const prefix = generated.slice(0, offset)
      const frame = {
        file: sourceMap.file,
        line: prefix.split('\n').length,
        column: prefix.length - prefix.lastIndexOf('\n'),
      }
      const mapped = renderSourceMappedFrame(frame, sourceMap)
      expect(mapped.file).toEndWith('original.ts')
      expect(mapped.line).toBe(5)
      expect(mapped.column).toBeGreaterThan(0)
      const bundle = collectDiagnosticBundle(
        [{ kind: 'bun-error', message: 'ordinary failure', frame }],
        { maxBytes: 4096 },
        { ...sourceMap, sources: ['/home/private-user/original.ts'] }
      )
      expect(bundle.records[0]!.frame!.file).toBe('~/original.ts')
      expect(bundle.records[0]!.frame!.line).toBe(5)
      expect(Object.isFrozen(bundle.records[0]!.frame)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBoundaries } from '../../scripts/quality/boundaries'

const temporary: string[] = []

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture(
  protocol: string,
  runtime: string,
  dependencies: Record<string, string> = { '@bun-native/protocol': 'workspace:*' }
) {
  const root = await mkdtemp(join(tmpdir(), 'bun-native-boundary-'))
  temporary.push(root)
  for (const [name, content] of [
    ['protocol', protocol],
    ['runtime', runtime],
  ] as const) {
    const dir = join(root, 'packages', name)
    await mkdir(join(dir, 'src'), { recursive: true })
    await Bun.write(
      join(dir, 'package.json'),
      JSON.stringify({
        name: `@bun-native/${name}`,
        exports: { '.': './src/index.ts' },
        dependencies: name === 'runtime' ? dependencies : {},
      })
    )
    await Bun.write(join(dir, 'src/index.ts'), content)
  }
  return root
}

describe('native package boundaries', () => {
  test('accepts public type-only dependency and a runtime platform import', async () => {
    const root = await fixture(
      'export type Message = { id: number }',
      'import type { Message } from "@bun-native/protocol"; import { spawn } from "bun";'
    )
    expect(await checkBoundaries(root)).toEqual([])
  })

  test('rejects reversed edges even for erased TypeScript imports', async () => {
    const root = await fixture(
      'import type { App } from "@bun-native/runtime";',
      'import type { Message } from "@bun-native/protocol";'
    )
    expect(await checkBoundaries(root)).toContain(
      'packages/protocol/src/index.ts: forbidden package dependency @bun-native/runtime'
    )
  })

  test.each([
    'import type { Message } from "../../protocol/src/index";',
    'export * from "../../protocol/src/index";',
    'const message = import("../../protocol/src/index");',
    'const message = require("../../protocol/src/index");',
    'type Message = import("../../protocol/src/index").Message;',
  ])('rejects private cross-package imports: %s', async (source) => {
    const root = await fixture('export type Message = {}', source, {})
    expect(
      (await checkBoundaries(root)).some((error) => error.includes('relative import escapes'))
    ).toBe(true)
  })

  test('rejects package subpaths not explicitly exported', async () => {
    const root = await fixture('', 'import { decode } from "@bun-native/protocol/src/internal";')
    expect(
      (await checkBoundaries(root)).some((error) => error.includes('bypasses public exports'))
    ).toBe(true)
  })

  test('rejects platform dependencies in the portable protocol', async () => {
    const root = await fixture('import { spawn } from "node:child_process";', '', {})
    expect(
      (await checkBoundaries(root)).some((error) =>
        error.includes('portable protocol imports platform')
      )
    ).toBe(true)
  })

  test('rejects undeclared and unused runtime dependencies', async () => {
    const undeclared = await fixture('', 'import { decode } from "@bun-native/protocol";', {})
    expect(
      (await checkBoundaries(undeclared)).some((error) => error.includes('undeclared dependency'))
    ).toBe(true)
    const unused = await fixture('', 'export const value = 1')
    expect(
      (await checkBoundaries(unused)).some((error) => error.includes('unused runtime dependency'))
    ).toBe(true)
  })

  test('rejects unresolvable dynamic import targets', async () => {
    const root = await fixture('', 'const path = "./other"; await import(path);', {})
    expect(
      (await checkBoundaries(root)).some((error) => error.includes('non-literal module load'))
    ).toBe(true)
  })

  test('does not mistake strings or comments for import edges', async () => {
    const root = await fixture(
      'export const text = \'import("@bun-native/runtime")\'; // import x from "node:fs"',
      '',
      {}
    )
    expect(await checkBoundaries(root)).toEqual([])
  })

  test('validates exact React external entries without allowing private reconciler imports', async () => {
    const root = await fixture('', '', {})
    const directory = join(root, 'packages/react')
    await mkdir(join(directory, 'src'), { recursive: true })
    const manifest = {
      name: '@bun-native/react',
      exports: { '.': './src/index.ts' },
      dependencies: { react: '19.3.1', 'react-reconciler': '0.34.0' },
    }
    await Bun.write(join(directory, 'package.json'), JSON.stringify(manifest))
    const source =
      'import { createElement } from "react"; import Reconciler from "react-reconciler"; import { ConcurrentRoot } from "react-reconciler/constants";'
    await Bun.write(join(directory, 'src/index.ts'), source)
    expect(await checkBoundaries(root)).toEqual([])
    await Bun.write(
      join(directory, 'src/index.ts'),
      source + ' import internal from "react-reconciler/cjs/react-reconciler.production.js";'
    )
    expect(await checkBoundaries(root)).toContain(
      'packages/react/src/index.ts: forbidden package dependency react-reconciler/cjs/react-reconciler.production.js'
    )
    await Bun.write(
      join(directory, 'package.json'),
      JSON.stringify({ ...manifest, dependencies: { react: '19.3.1' } })
    )
    await Bun.write(join(directory, 'src/index.ts'), source)
    expect(await checkBoundaries(root)).toContain(
      'packages/react/src/index.ts: undeclared dependency react-reconciler'
    )
  })

  test('invalid source cannot silently remove a package edge from the audit', async () => {
    const root = await fixture('import {', '', {})
    expect((await checkBoundaries(root)).some((error) => error.includes('parse error'))).toBe(true)
  })
})

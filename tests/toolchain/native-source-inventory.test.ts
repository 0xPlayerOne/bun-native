import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { nativeSourcePaths } from '../../experiments/aot-gpui/native-sources.ts'

describe('AOT native source provenance inventory', () => {
  test('includes manifests and root/nested Rust sources across every crate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bun-native-source-inventory-'))
    const expected = [
      'native/gpui-host/Cargo.toml',
      'native/gpui-host/src/channel.rs',
      'native/gpui-host/src/main.rs',
      'native/gpui-host/src/services/clipboard/x11.rs',
      'native/protocol/Cargo.toml',
      'native/protocol/src/lib.rs',
      'native/extra-platform/Cargo.toml',
      'native/extra-platform/src/surface/layer.rs',
      'native/vendor/example-hal/Cargo.toml',
      'native/vendor/example-hal/build.rs',
      'native/vendor/example-hal/src/lib.rs',
      'native/vendor/example-hal/src/shaders/clear.frag',
      'native/vendor/example-hal/src/shaders/clear.vert',
    ]
    try {
      for (const path of [
        ...expected,
        'native/gpui-host/examples/peer.rs',
        'native/gpui-host/src/readme.txt',
        'native/vendor/example-hal/target/generated.rs',
        'native/vendor/example-hal/examples/example.rs',
        'packages/runtime/src/index.ts',
      ].reverse()) {
        const file = join(directory, path)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, '// deterministic inventory fixture\n')
      }
      expect(await nativeSourcePaths(directory)).toEqual([...expected].sort())
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('matches an independent filesystem walk of the actual native workspace', async () => {
    const source = resolve(import.meta.dir, '../..')
    const expected: string[] = []
    function walk(directory: string, includeAssets = false): void {
      if (!existsSync(join(source, directory))) return
      for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`
        if (entry.isDirectory()) walk(path, includeAssets)
        else if (entry.isFile() && (includeAssets || entry.name.endsWith('.rs')))
          expected.push(path)
      }
    }
    for (const crate of readdirSync(join(source, 'native'), { withFileTypes: true })) {
      if (!crate.isDirectory()) continue
      const manifest = `native/${crate.name}/Cargo.toml`
      if (existsSync(join(source, manifest))) expected.push(manifest)
      walk(`native/${crate.name}/src`)
    }
    for (const crate of readdirSync(join(source, 'native/vendor'), { withFileTypes: true })) {
      if (!crate.isDirectory()) continue
      for (const name of ['Cargo.toml', 'build.rs']) {
        const path = `native/vendor/${crate.name}/${name}`
        if (existsSync(join(source, path))) expected.push(path)
      }
      walk(`native/vendor/${crate.name}/src`, true)
    }
    expect(expected).toContain('native/gpui-host/src/channel.rs')
    expect(expected).toContain('native/macos-surface/src/lib.rs')
    expect(expected).toContain('native/vendor/wgpu-hal/src/gles/egl.rs')
    expect(expected).toContain('native/vendor/wgpu-hal/src/gles/shaders/srgb_present.frag')
    expect(await nativeSourcePaths(source)).toEqual(expected.sort())
  })
})

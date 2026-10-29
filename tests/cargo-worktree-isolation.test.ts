import { expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { cargoTargetDirectory } from '../scripts/cargo-artifacts.ts'
import { cargoEnvironment } from '../scripts/cargo-config.ts'

test('canonical manifest directories isolate checkouts, preserve aliases and match artifact lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-cargo-worktrees-'))
  const current = {
    BUNLY_SHARED_CACHE_DIR: join(root, 'cache'),
    CARGO_HOME: join(root, 'cargo-home'),
  }
  const manifests = ['a', 'b'].map((name) => join(root, name, 'native/cef-host/Cargo.toml'))
  const environment = (manifest: string) =>
    cargoEnvironment(
      ['test', '--manifest-path', manifest],
      current,
      undefined,
      undefined,
      '156.0.0+156.0.7'
    )
  const spawn = spyOn(Bun, 'spawnSync')
  try {
    for (const manifest of manifests) {
      await mkdir(dirname(manifest), { recursive: true })
      await writeFile(manifest, '[workspace]\n')
    }
    const first = environment(manifests[0]!)
    const second = environment(manifests[1]!)
    expect(first.targetDir).not.toBe(second.targetDir)
    expect(first.env.CARGO_HOME).toBe(current.CARGO_HOME)
    expect(second.env.CARGO_HOME).toBe(current.CARGO_HOME)
    expect(first.env.CEF_PATH).toBe(second.env.CEF_PATH)
    expect(first.env.CEF_PATH).toBe(join(current.BUNLY_SHARED_CACHE_DIR, 'cef', '156.0.0+156.0.7'))

    const alias = join(root, 'alias')
    await symlink(join(root, 'a'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(environment(join(alias, 'native/cef-host/Cargo.toml')).targetDir).toBe(first.targetDir)
    await writeFile(manifests[0]!, '[workspace]\n# source edit\n')
    expect(environment(manifests[0]!).targetDir).toBe(first.targetDir)

    for (const [index, manifest] of manifests.entries()) {
      const selected = index === 0 ? first.targetDir! : second.targetDir!
      spawn.mockReturnValue({
        success: true,
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({ target_directory: selected })),
        stderr: Buffer.alloc(0),
      } as ReturnType<typeof Bun.spawnSync>)
      expect(cargoTargetDirectory(manifest, current)).toBe(selected)
      expect(spawn.mock.calls[index]![1]).toMatchObject({
        env: { CARGO_TARGET_DIR: selected, CARGO_HOME: current.CARGO_HOME },
      })
      const lookup = spawn.mock.calls[index]![1] as { env: NodeJS.ProcessEnv }
      // Metadata selects the same namespace without discovering/downloading CEF.
      expect(lookup.env.CEF_PATH).toBeUndefined()
    }
  } finally {
    spawn.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

// The portable gate remains compiler-free. Native contributors explicitly run
// this offline Cargo regression with the pinned CEF compiler installed.
test.skipIf(process.env['BUNLY_CARGO_ISOLATION_NATIVE'] !== '1')(
  'real Cargo tests execute each checkout and reuse dependencies after a source edit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunly-cargo-native-isolation-'))
    const runner = resolve(import.meta.dir, '../scripts/cargo.ts')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BUNLY_SHARED_CACHE_DIR: join(root, 'cache'),
      RUSTUP_TOOLCHAIN: '1.91.0',
      CARGO_TERM_COLOR: 'never',
    }
    delete env.CARGO_TARGET_DIR
    delete env.CARGO_BUILD_TARGET
    const manifest = (name: string) => join(root, name, 'Cargo.toml')
    const source = (name: string) => join(root, name, 'src/lib.rs')
    const run = async (name: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          runner,
          '+1.91.0',
          'test',
          '--offline',
          '--locked',
          '--manifest-path',
          manifest(name),
          '--lib',
        ],
        { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
      )
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exit, stderr }).toMatchObject({ exit: 0 })
      return { stdout, stderr }
    }
    try {
      await mkdir(join(root, 'dependency/src'), { recursive: true })
      await writeFile(
        join(root, 'dependency/Cargo.toml'),
        '[package]\nname = "bunly_cache_probe_dep"\nversion = "0.0.0"\nedition = "2021"\n'
      )
      await writeFile(join(root, 'dependency/src/lib.rs'), 'pub fn marker() -> u8 { 7 }\n')
      // Both sources exist before A compiles, reproducing B's older mtimes.
      for (const name of ['a', 'b']) {
        await mkdir(dirname(source(name)), { recursive: true })
        await writeFile(
          manifest(name),
          '[package]\nname = "bunly_cache_probe"\nversion = "0.0.0"\nedition = "2021"\n[dependencies]\nbunly_cache_probe_dep = { path = "../dependency" }\n'
        )
        await writeFile(
          join(root, name, 'Cargo.lock'),
          'version = 4\n[[package]]\nname = "bunly_cache_probe"\nversion = "0.0.0"\ndependencies = ["bunly_cache_probe_dep"]\n[[package]]\nname = "bunly_cache_probe_dep"\nversion = "0.0.0"\n'
        )
      }
      await writeFile(
        source('a'),
        '#[test] fn alpha_marker() { assert_eq!(bunly_cache_probe_dep::marker(), 7); }\n'
      )
      await writeFile(
        source('b'),
        '#[test] fn beta_marker_one() { assert_eq!(bunly_cache_probe_dep::marker(), 7); }\n#[test] fn beta_marker_two() {}\n'
      )
      const first = await run('a')
      expect(first.stdout).toContain('test alpha_marker ... ok')
      const second = await run('b')
      expect(second.stderr).toContain('Compiling bunly_cache_probe v0.0.0')
      expect(second.stdout).toContain('test beta_marker_one ... ok')
      expect(second.stdout).toContain('test beta_marker_two ... ok')
      expect(second.stdout).not.toContain('alpha_marker')
      const firstTarget = cargoEnvironment(['--manifest-path', manifest('a')], env).targetDir!
      const secondTarget = cargoEnvironment(['--manifest-path', manifest('b')], env).targetDir!
      expect(firstTarget).not.toBe(secondTarget)
      expect(await readFile(source('b'), 'utf8')).toContain('beta_marker_two')

      await writeFile(
        source('a'),
        '#[test] fn alpha_after_edit() { assert_eq!(bunly_cache_probe_dep::marker(), 7); }\n'
      )
      const edited = await run('a')
      expect(edited.stdout).toContain('test alpha_after_edit ... ok')
      expect(edited.stdout).not.toContain('test alpha_marker')
      expect(edited.stderr).toContain('Compiling bunly_cache_probe v0.0.0')
      expect(edited.stderr).not.toContain('Compiling bunly_cache_probe_dep')
      expect(cargoEnvironment(['--manifest-path', manifest('a')], env).targetDir).toBe(firstTarget)
      console.info(
        JSON.stringify({
          event: 'bunly.cargo-worktree-isolation',
          firstTests: 1,
          secondTests: 2,
          editedTests: 1,
          sourceEditRecompiled: true,
          dependencyReused: true,
        })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

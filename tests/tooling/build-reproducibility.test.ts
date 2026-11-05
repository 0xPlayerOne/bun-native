import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createProject } from '../../scripts/native/project.ts'

const repository = resolve(import.meta.dir, '../..')
const cli = join(repository, 'scripts/native.ts')

function files(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  )
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

// Two clean builds of equal sources from different checkout locations, process
// working directories and times must produce byte-identical packaged outputs.
// Only the declared diagnostics (logs and wall-clock timing) may differ.
test('AOT builds of equal sources are byte-identical across locations and working directories', async () => {
  const cache = join(repository, '.bun-native')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'reproducible-'))
  try {
    const projects = [join(directory, 'first/app'), join(directory, 'second/app')]
    for (const project of projects) await createProject(repository, project, 'solid', 'typescript')
    for (const path of files(projects[0]!))
      expect(sha256(join(projects[1]!, path))).toBe(sha256(join(projects[0]!, path)))
    const working = [repository, mkdtempSync(join(tmpdir(), 'bun-native-build-cwd-'))]
    try {
      for (const [index, project] of projects.entries()) {
        const result = Bun.spawnSync(
          [
            process.execPath,
            cli,
            'build',
            relative(working[index]!, project),
            '--host',
            process.execPath,
            '--host-profile',
            'release',
          ],
          { cwd: working[index]!, stdout: 'pipe', stderr: 'pipe', timeout: 150_000 }
        )
        if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      }
    } finally {
      rmSync(working[1]!, { recursive: true, force: true })
    }
    const [first, second] = projects.map((project) => join(project, 'dist'))
    const manifest = JSON.parse(readFileSync(join(first!, 'manifest.json'), 'utf8'))
    const { deterministic, diagnostics } = manifest.reproducibility as Record<string, string[]>
    expect(files(first!).sort()).toEqual([...deterministic!, ...diagnostics!].sort())
    expect(files(second!).sort()).toEqual(files(first!).sort())
    for (const path of deterministic!)
      expect({ path, sha256: sha256(join(second!, path)) }).toEqual({
        path,
        sha256: sha256(join(first!, path)),
      })
    const text = readFileSync(join(first!, 'manifest.json'), 'utf8')
    expect(text).not.toContain(directory)
    expect(text).not.toContain(process.execPath)
    expect(manifest.application.compileCommand.slice(0, 3)).toEqual([
      'bun',
      '--no-install',
      'compile',
    ])
    expect(manifest.application.compiler.revision).toBe(Bun.revision)
    expect(manifest.sourceMap.sha256).toBe(sha256(join(first!, 'development/application.js.map')))
    const metrics = JSON.parse(readFileSync(join(first!, 'build-metrics.json'), 'utf8'))
    expect(metrics.compileMs).toBeGreaterThan(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 330_000)

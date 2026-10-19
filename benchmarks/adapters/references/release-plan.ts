/** Executable installation/assembly/archive stages; unsupported release stages stay explicit. */
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { STAGES } from '../../lib/stages.ts'
import {
  validateReleasePlan,
  type ReleasePlan,
  type ReleaseTask,
} from '../../lib/release-workflow.ts'
import { REFERENCE_PACKAGES, type ReferenceName } from './packages.ts'
import { referenceArtifactPath } from './layout.ts'
const root = resolve(import.meta.dir, '../../..')
/** Workspace must be new. Frozen lock is caller-supplied, hash-pinned and never fabricated. */
export async function prepareReferenceRelease(
  name: ReferenceName,
  workspace: string,
  frozenLock: string,
  lockSha256: string
): Promise<ReleasePlan> {
  if (!Object.hasOwn(REFERENCE_PACKAGES, name) || !/^[a-f0-9]{64}$/.test(lockSha256))
    throw new Error('Expected reference and frozen lock digest')
  const info = await lstat(frozenLock)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
    throw new Error('Invalid frozen reference lock')
  const lock = await readFile(frozenLock)
  if (createHash('sha256').update(lock).digest('hex') !== lockSha256)
    throw new Error('Reference lock hash mismatch')
  const project = resolve(workspace),
    templates = join(root, 'benchmarks/fixtures/desktop-edit')
  await mkdir(project, { mode: 0o700 }) // Refuse pre-existing projects and their caches.
  await mkdir(join(project, 'src'))
  await mkdir(join(project, '.benchmark-home'))
  await copyFile(
    join(root, `benchmarks/adapters/references/${name}.package.json`),
    join(project, 'package.json')
  )
  await writeFile(join(project, 'bun.lock'), lock)
  for (const file of ['host.ts', name + '.ts'])
    await copyFile(join(templates, file + '.txt'), join(project, 'src', file))
  await writeFile(join(project, 'src/revision.ts'), "export const revision = 'initial';\n")
  await writeFile(join(project, 'index.html'), '<!doctype html><title>Reference bootstrap</title>')
  if (name === 'mirin') {
    await copyFile(join(templates, 'mirin.config.ts.txt'), join(project, 'mirin.config.ts'))
    await writeFile(
      join(project, 'vite.config.ts'),
      'export default { build: { outDir: "dist" } };\n'
    )
  } else await copyFile(join(templates, 'butter.yaml.txt'), join(project, 'butter.yaml'))
  const spec = REFERENCE_PACKAGES[name],
    bin = process.execPath
  const environment = {
    HOME: join(project, '.benchmark-home'),
    USERPROFILE: join(project, '.benchmark-home'),
    BUN_INSTALL_CACHE_DIR: join(project, '.benchmark-home/bun-cache'),
    MIRIN_SIGN_IDENTITY: '-',
    MIRIN_RELEASE_BASE_URL: '',
    MIRIN_RELEASE_CHANNEL: '',
    MIRIN_APP_VERSION: '',
    PATH: dirname(bin) + (process.platform === 'win32' ? ';' : ':') + (process.env['PATH'] ?? ''),
  }
  const task = (
    commands: readonly (readonly string[])[],
    verify: readonly string[],
    dependsOn: ReleaseTask['dependsOn'],
    outputs: ReleaseTask['outputs']
  ): ReleaseTask => ({ commands, verify, dependsOn, outputs, timeoutMs: 300000, environment })
  const artifact = referenceArtifactPath(name, process.platform),
    archive = 'release/BunlyReference.tar.gz'
  const python = process.env['PYTHON'] ?? 'python'
  return validateReleasePlan({
    schema: 1,
    framework: spec.framework,
    version: spec.version,
    sourceCommit: spec.sourceCommit,
    tasks: {
      'cold-install': task(
        [
          [
            bin,
            'install',
            '--frozen-lockfile',
            '--ignore-scripts',
            '--linker=hoisted',
            '--backend=copyfile',
          ],
        ],
        [bin, join(root, 'scripts/verify-reference-stage.ts'), name, lockSha256],
        [],
        []
      ),
      'app-assembly': task(
        [[bin, join(project, 'node_modules', spec.cli, spec.entry), ...spec.build]],
        [bin, join(root, 'scripts/verify-reference-stage.ts'), name, lockSha256],
        ['cold-install'],
        [
          {
            category: 'installed',
            path: artifact,
            kind: name === 'butter' ? 'file' : 'directory',
            fresh: true,
          },
          { category: 'cache', path: '.benchmark-home', kind: 'directory', fresh: false },
        ]
      ),
      'installer-compress': task(
        [[python, join(root, 'scripts/reference_archive.py'), 'create', artifact, archive]],
        [python, join(root, 'scripts/reference_archive.py'), 'verify', artifact, archive],
        ['app-assembly'],
        [{ category: 'installer', path: archive, kind: 'file', fresh: true }]
      ),
    },
    unsupported: Object.fromEntries(
      STAGES.filter((s) => !['cold-install', 'app-assembly', 'installer-compress'].includes(s)).map(
        (stage) => [
          stage,
          stage === 'release-sign'
            ? 'No independently configured and verified platform signing identity; upstream build may include inseparable ad-hoc signing'
            : stage === 'first-run'
              ? 'Installed clean-profile startup requires the actual desktop runner; archive verification is not startup'
              : stage === 'update'
                ? 'This profile creates a portable full archive, not a verified framework updater transaction'
                : 'This release profile does not measure interactive development; use the separate edit driver',
        ]
      )
    ),
  })
}

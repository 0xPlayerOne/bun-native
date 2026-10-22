import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dir, '..')
const directory = join(root, '.bunly/benchmarks/electrobun-project')
const bootstrap = join(
  root,
  'benchmarks/adapters/electrobun/node_modules/electrobun/bin/electrobun.cjs'
)
const installed = JSON.parse(await readFile(join(bootstrap, '../../package.json'), 'utf8')) as {
  version: string
}
if (installed.version !== '2.0.3-beta.26') throw new Error('Electrobun bootstrap version mismatch')
await mkdir(join(directory, 'src'), { recursive: true })
for (const file of ['hutch.config', 'electrobun.config'])
  await copyFile(
    join(root, `benchmarks/adapters/electrobun/template/${file}.ts.txt`),
    join(directory, `${file}.ts`)
  )
await copyFile(
  join(root, 'benchmarks/adapters/electrobun/template/main.ts.txt'),
  join(directory, 'src/main.ts')
)
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify({ name: 'bunly-baseline-app', private: true, type: 'module' }, null, 2) + '\n'
)
await writeFile(
  join(directory, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: './.hutch/devkit/tsconfig.json',
      compilerOptions: { strict: true, noEmit: true },
      include: ['src/**/*.ts'],
    },
    null,
    2
  ) + '\n'
)
const stages: { stage: string; elapsedMs: number; exitCode: number }[] = []
for (const args of [['prepare'], ['config', '--env=dev'], ['build', '--env=dev']]) {
  const started = performance.now()
  const child = Bun.spawn([process.execPath, bootstrap, ...args], {
    cwd: directory,
    env: { ...process.env, HUTCH_HOME: join(root, '.bunly/benchmarks/hutch-home') },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const timer = setTimeout(() => child.kill(), 240000)
  const exitCode = await child.exited
  clearTimeout(timer)
  stages.push({ stage: args[0]!, elapsedMs: performance.now() - started, exitCode })
  await writeFile(
    join(root, '.bunly/benchmarks/electrobun-setup.json'),
    JSON.stringify(
      {
        schema: 1,
        bootstrapVersion: installed.version,
        hostBun: Bun.version,
        sourceCommit: process.env['GITHUB_SHA'] ?? 'local',
        stages,
        classification: 'ci-or-local-setup-evidence-not-controlled-performance',
      },
      null,
      2
    )
  )
  if (exitCode !== 0) throw new Error('Electrobun ' + args[0] + ' failed')
}
console.log(JSON.stringify({ event: 'electrobun-prepared', directory, stages }))

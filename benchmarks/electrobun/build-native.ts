/** Build and inspect the exact Core/AOT workload used by the visible-input smoke. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { bundleApplication } from '../../scripts/native/bundle.ts'
import { inspectBunExecutable } from '../../scripts/native/inspect.ts'
import toolchain from '../../toolchain.json'

const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true })
assert.equal(Bun.revision, toolchain.bun.revision, 'Use the pinned Bun compiler')
assert(values.output && isAbsolute(values.output), '--output must be absolute')
assert(
  process.env['RUNNER_TEMP'] && isAbsolute(process.env['RUNNER_TEMP']),
  'RUNNER_TEMP is required'
)
const temp = realpathSync(process.env['RUNNER_TEMP'])
const output = join(realpathSync(dirname(values.output)), values.output.split('/').at(-1)!)
const part = relative(temp, output)
assert(part && !part.startsWith('..') && !isAbsolute(part), 'Output must be inside RUNNER_TEMP')
assert(!existsSync(output), 'Output already exists')
const root = resolve(import.meta.dir, '../..')
mkdirSync(output)
await bundleApplication({
  framework: 'solid',
  entry: join(root, 'benchmarks/solid/direct.ts'),
  outdir: join(output, 'module'),
  cwd: root,
})
const binary = join(output, 'application')
const compiler = Bun.spawn(
  [
    process.execPath,
    ...toolchain.bun.compileArguments,
    join(output, 'module/application.js'),
    '--outfile',
    binary,
  ],
  {
    stdout: Bun.file(join(output, 'compile.stdout.log')),
    stderr: Bun.file(join(output, 'compile.stderr.log')),
  }
)
const exit = await compiler.exited
assert.equal(exit, 0, 'Bun AOT compilation failed; see retained compiler logs')
const inspection = inspectBunExecutable(binary)
assert(inspection.hasCompiledProgram, 'Artifact lacks the compiled-program flag')
const bytes = readFileSync(binary)
writeFileSync(
  join(output, 'build.json'),
  JSON.stringify(
    {
      status: 'passed',
      bunRevision: Bun.revision,
      inspection,
      binary: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    },
    null,
    2
  ) + '\n',
  { flag: 'wx' }
)

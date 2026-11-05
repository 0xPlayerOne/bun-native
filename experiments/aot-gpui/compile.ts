import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspectBunExecutable } from './inspect'
import { inspectBunRuntime } from './inspect-runtime'
import toolchain from '../../toolchain.json'

/** Shared real AOT compiler and executable checks for fixtures and application tooling. */
export function compileApplication(input: string, output: string, cwd: string, trim = false) {
  if (Bun.revision !== toolchain.bun.revision) throw new Error('Use the pinned Bun AOT compiler')
  const compileCommand = [
    process.execPath,
    '--no-install',
    'compile',
    '--no-script',
    '--production',
    ...(trim ? ['--trim'] : []),
    '--explain=json',
    input,
    '--outfile',
    output,
  ]
  const start = performance.now()
  const result = Bun.spawnSync(compileCommand, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  })
  writeFileSync(join(dirname(output), 'compile-aot.stdout.log'), result.stdout)
  writeFileSync(join(dirname(output), 'compile-aot.stderr.log'), result.stderr)
  if (result.exitCode !== 0)
    throw new Error(`compile-aot failed (${result.exitCode}): ${result.stderr}`)
  const buildMs = performance.now() - start
  const inspection = inspectBunExecutable(output)
  if (!inspection.hasCompiledProgram)
    throw new Error('Compiler output has no compiled-program record')
  const runtimeFeatures = inspectBunRuntime(output)
  if (runtimeFeatures.jit === 'present' || runtimeFeatures.jitRemovedRanges.count === 0)
    throw new Error('Compiler output does not record removal of the JIT compiler')
  return { compileCommand, buildMs, inspection, runtimeFeatures }
}

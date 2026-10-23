import { test, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { observedCommand } from '../benchmarks/lib/observed-command.ts'
for (const delay of [0, 5, 100])
  test(`cancellation buffered before slow Python startup (${delay} ms) still records cleanup`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunly-observer-startup-'))
    let reaped = false
    try {
      // A trusted Python wrapper delays loading the real observer. No interpreter
      // policy/startup hook is replaced, and the target command is unchanged.
      const wrapper =
        'import runpy,sys,time;from pathlib import Path;t=time.monotonic();time.sleep(0.75);Path(sys.argv[1],"startup.txt").write_text(str(time.monotonic()-t));sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name="__main__")'
      const controller = new AbortController()
      const child = observedCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
        cwd: directory,
        output: join(directory, 'report.json'),
        timeoutMs: 3000,
        signal: controller.signal,
        observerCommand: [process.env['PYTHON'] ?? 'python', '-c', wrapper, directory],
      })
      const timer = setTimeout(() => controller.abort(), delay)
      const result = await child.result
      clearTimeout(timer)
      reaped = result.cleanupSurvivors.length === 0
      expect(Number(await readFile(join(directory, 'startup.txt'), 'utf8'))).toBeGreaterThanOrEqual(
        0.5
      )
      expect(result.cancelled).toBe(true)
      expect(result.timedOut).toBe(false)
      expect(result.observedOrphans).toEqual([])
      expect(result.cleanupSurvivors).toEqual([])
    } finally {
      // A failure to read a report must not delete files beneath unknown work.
      if (reaped) await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

for (const selection of ['basename', 'relative'] as const)
  test(`observer resolves ${selection} interpreter before applying child PATH and cwd`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'bunly-observer-environment-')))
    let reaped = false
    try {
      const python = Bun.which(process.env['PYTHON'] ?? 'python')
      if (!python) throw new Error('Python contributor environment is required')
      const childCwd = join(directory, 'unrelated-cwd')
      const emptyPath = join(directory, 'empty-path')
      await mkdir(childCwd)
      await mkdir(emptyPath)
      const interpreter = selection === 'basename' ? basename(python) : relative(directory, python)
      const report = join(directory, 'report.json')
      const driver = join(directory, 'driver.ts')
      await writeFile(
        driver,
        `
        import { observedCommand, assertCleanCommand } from ${JSON.stringify(
          join(import.meta.dir, '../benchmarks/lib/observed-command.ts')
        )};
        const observation = await observedCommand(
          [process.execPath, '-e', 'console.log(JSON.stringify({cwd:process.cwd(),path:process.env.PATH}))'],
          {cwd:${JSON.stringify(childCwd)},output:${JSON.stringify(report)},timeoutMs:3000,
           env:{PATH:${JSON.stringify(emptyPath)}}}
        ).result;
        assertCleanCommand(observation);
        console.log(JSON.stringify(observation));
      `
      )
      const run = Bun.spawn([process.execPath, driver], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: dirname(python) + delimiter + (process.env['PATH'] ?? ''),
          PYTHON: interpreter,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        run.exited,
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
      ])
      expect(stderr).toBe('')
      expect(code).toBe(0)
      const observation = JSON.parse(stdout)
      reaped = observation.cleanupSurvivors.length === 0
      expect(observation.timedOut).toBe(false)
      expect(observation.observedOrphans).toEqual([])
      const target = observation.stdoutTail.map((line: string) => JSON.parse(line))
      expect(target).toEqual([{ cwd: await realpath(childCwd), path: emptyPath }])
    } finally {
      if (reaped) await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

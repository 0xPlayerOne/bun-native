/** A finished command's exit code and decoded output. */
export type Command = { exitCode: number; stdout: string; stderr: string }
/** Runs one command; tests substitute a runner where the real tools do not exist. */
export type Runner = (command: string[]) => Command

/** A runner that spawns the command, captures both streams and kills it after `timeoutMs`. */
export function commandRunner(timeoutMs: number): Runner {
  return (command) => {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  }
}

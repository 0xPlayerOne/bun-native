import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One identity publication per phase in the holder's private control directory. */
export function publishHolderIdentity(
  directory: string,
  phase: 'started' | 'ready' | 'finished'
): void {
  const destination = join(directory, phase)
  const pending = destination + '.pending'
  // The parent uses existence as the publication barrier. Never expose an
  // empty or partial PID between file creation and completion of the write.
  writeFileSync(pending, String(process.pid), { flag: 'wx' })
  renameSync(pending, destination)
}

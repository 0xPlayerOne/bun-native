import { rm } from 'node:fs/promises'

const transient = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'])

/** Test fixture cleanup only: retain Node's five retries and linear 25 ms budget. */
export async function removeSessionResetFixture(
  path: string,
  remove: (path: string) => Promise<void> = (target) =>
    rm(target, { recursive: true, force: true }),
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (attempt >= 5 || !code || !transient.has(code)) throw error
      await wait(25 * (attempt + 1))
    }
  }
}

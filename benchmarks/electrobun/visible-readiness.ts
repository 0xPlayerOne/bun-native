/** Retry only pre-input display/surface races; every rejected capture is retained. */
export async function awaitVisibleReadiness<T>(
  name: string,
  deadline: number,
  capture: (name: string) => Promise<T>,
  mismatches: string[],
  now: () => number = () => performance.now(),
  pause: () => Promise<unknown> = () => Bun.sleep(50)
): Promise<T> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const captureName =
      attempt === 1 ? name : `${name}-correspondence-${String(attempt).padStart(2, '0')}`
    try {
      return await capture(captureName)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith('Display and owned surface differ in the label region')
      )
        throw error
      mismatches.push(captureName)
      if (attempt === 20 || now() > deadline) throw error
      await pause()
    }
  }
  throw new Error('Readiness capture exhausted')
}

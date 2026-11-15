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

/** Retry only an explicit pre-input obstruction; retain every guard response. */
export async function awaitUnobstructedStream<
  T extends {
    status: string
    visibleRegionVerified?: boolean
    visibleRegionObstruction?: unknown
  },
>(
  deadline: number,
  inspect: () => Promise<T>,
  attempts: T[],
  now: () => number = () => performance.now(),
  pause: () => Promise<unknown> = () => Bun.sleep(50)
): Promise<T> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const guard = await inspect()
    attempts.push(guard)
    if (guard.status !== 'ready') throw new Error('Stream guard is not ready')
    if (guard.visibleRegionVerified === true) return guard
    if (guard.visibleRegionVerified !== false || !guard.visibleRegionObstruction)
      throw new Error('Stream guard returned invalid obstruction evidence')
    if (attempt === 20 || now() > deadline) throw new Error('Stream label region is obstructed')
    await pause()
  }
  throw new Error('Stream readiness exhausted')
}

/** Await an observed IPC/React state, not an unrelated request acknowledgement. */
export async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('React event state did not settle')
    await Bun.sleep(1)
  }
}

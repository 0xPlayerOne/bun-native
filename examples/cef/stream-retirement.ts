/** Fixture acceptance joins distinct transport and native-owner retirement receipts. */
export async function requireStreamRetirement(
  closed: Promise<unknown>,
  signal: AbortSignal,
  action: () => Promise<void>,
  timeoutMs = 10000
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new TypeError('Invalid stream retirement deadline')
  let notify!: () => void
  const revoked = new Promise<void>((resolve) => {
    notify = resolve
  })
  signal.addEventListener('abort', notify, { once: true })
  if (signal.aborted) notify()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = performance.now() + timeoutMs
  try {
    await Promise.race([
      Promise.all([Promise.resolve().then(action), closed, revoked]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native stream retirement deadline')), timeoutMs)
      }),
    ])
    if (performance.now() >= deadline) throw new Error('Late native stream retirement')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', notify)
  }
}

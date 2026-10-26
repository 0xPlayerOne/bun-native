/** Fixed graphical negative-control ordering. The held consumer must exist before a burst. */
export async function beginTerminalNegativeControl(
  role: 'navigate' | 'overload',
  hooks: {
    readonly arm: () => void
    readonly control: (action: 'stall' | 'overload') => Promise<unknown>
    readonly held: Promise<void>
    readonly pending: () => void
  }
): Promise<void> {
  hooks.arm()
  // A source may receive the whole burst in its first callback. First admit a
  // small stall record and observe real consumer entry, then issue the burst.
  await hooks.control('stall')
  await hooks.held
  hooks.pending()
  if (role === 'overload') await hooks.control('overload')
}

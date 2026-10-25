import { test, expect } from 'bun:test'
import { requireStreamRetirement } from '../examples/cef/stream-retirement.ts'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
for (const order of ['transport-first', 'revocation-first'] as const) {
  test(`stream acceptance awaits both independent receipts: ${order}`, async () => {
    const closed = deferred(),
      owner = new AbortController()
    let complete = false,
      actions = 0
    const waiting = requireStreamRetirement(closed.promise, owner.signal, async () => {
      actions++
    }).then(() => {
      complete = true
    })
    if (order === 'transport-first') closed.resolve()
    else owner.abort()
    await turn()
    expect(complete).toBe(false)
    expect(actions).toBe(1)
    if (order === 'transport-first') owner.abort()
    else closed.resolve()
    await waiting
    expect(complete).toBe(true)
  })
}
test('retirement acceptance retains action and transport failures', async () => {
  const owner = new AbortController()
  owner.abort()
  await expect(
    requireStreamRetirement(Promise.resolve(), owner.signal, async () => {
      throw new Error('action rejected')
    })
  ).rejects.toThrow('action rejected')
  await expect(
    requireStreamRetirement(
      Promise.reject(new Error('transport rejected')),
      owner.signal,
      async () => {}
    )
  ).rejects.toThrow('transport rejected')
})
test('missing owner or transport receipt cannot become successful retirement', async () => {
  const missing = deferred(),
    owner = new AbortController()
  await expect(
    requireStreamRetirement(Promise.resolve(), owner.signal, async () => {}, 10)
  ).rejects.toThrow('deadline')
  owner.abort()
  await expect(
    requireStreamRetirement(missing.promise, owner.signal, async () => {}, 10)
  ).rejects.toThrow('deadline')
})

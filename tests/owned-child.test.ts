import { test, expect } from 'bun:test'
import { ownedChild } from '../benchmarks/lib/owned-child.ts'
const command = (code: string) => [process.execPath, '-e', code]
test('owned fixture observes records and deterministically closes a live child', async () => {
  const child = ownedChild(
    command('console.log(JSON.stringify({event:"ready"}));setInterval(()=>{},1000)'),
    process.cwd()
  )
  try {
    expect((await child.wait((value) => value['event'] === 'ready'))['event']).toBe('ready')
    expect(child.cursor()).toBeGreaterThan(0)
    const pending = child
      .wait(() => false)
      .then(
        () => 'unexpected',
        (error) => String(error)
      )
    await child.close()
    expect(await pending).toContain('closed')
    await child.close()
  } finally {
    await child.close()
  }
})
test('owned fixture enforces waiter deadlines and isolates predicate exceptions', async () => {
  const child = ownedChild(
    command('console.log(JSON.stringify({event:"ready"}));setInterval(()=>{},1000)'),
    process.cwd()
  )
  try {
    await child.wait((value) => value['event'] === 'ready')
    await expect(child.wait(() => false, child.cursor(), 20)).rejects.toThrow('deadline')
    await expect(
      child.wait(() => {
        throw new Error('predicate failure')
      })
    ).rejects.toThrow('predicate failure')
    await expect(child.wait(() => false, 0, Number.NaN)).rejects.toThrow('Invalid')
    expect((await child.wait((value) => value['event'] === 'ready'))['event']).toBe('ready')
  } finally {
    await child.close()
  }
})
test('owned fixture rejects oversized output instead of buffering indefinitely', async () => {
  const child = ownedChild(
    command('process.stdout.write("x".repeat(300000));setInterval(()=>{},1000)'),
    process.cwd()
  )
  try {
    await expect(child.wait(() => false)).rejects.toThrow('output limit')
  } finally {
    await child.close()
  }
})

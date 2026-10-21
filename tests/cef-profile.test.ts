import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { cefQualificationOptions, qualificationConfig } from '../benchmarks/lib/cef-profile.ts'
import { NativeTransport } from '../packages/runtime/src/native-transport.ts'

test('normal qualification is not automatically retried or deadline-scaled', () => {
  const options = cefQualificationOptions(['/fixture/runtime'])
  expect(options.emulated).toBe(false)
  expect(options.profile).toBe('standard')
  expect(options.processTimeoutMs).toBe(60000)
  expect(options.pageTimeoutMs).toBe(10000)
  const original = { schema: 1 }
  expect(qualificationConfig(original, false)).toEqual(original)
  expect(qualificationConfig(original, true)).toEqual({
    schema: 1,
    qualification_profile: 'emulated-functional',
  })
  expect(original).toEqual({ schema: 1 })
})
test('emulation is explicit, bounded and cannot inherit a previously changed artifact', () => {
  expect(
    cefQualificationOptions(['/fixture/runtime', '--emulated-functional']).processTimeoutMs
  ).toBe(300000)
  for (const args of [
    [],
    [''],
    ['app', '--relax'],
    ['app', '--emulated-functional', '--emulated-functional'],
  ])
    expect(() => cefQualificationOptions(args)).toThrow()
  for (const value of [
    null,
    [],
    { qualification_profile: 'standard' },
    { qualification_profile: null },
  ])
    expect(() => qualificationConfig(value, true)).toThrow()
})
test('private native readiness accepts only the finite deadline profiles', async () => {
  for (const data of [
    undefined,
    { deadlineProfile: 'standard', requestTimeoutMs: 10000 },
    { deadlineProfile: 'emulated-functional', requestTimeoutMs: 30000 },
  ]) {
    const input = new PassThrough(),
      output = new PassThrough()
    const transport = new NativeTransport(input, output)
    input.write(JSON.stringify({ v: 1, event: 'ready', abi: 1, data }) + '\n')
    await transport.ready
    input.write(JSON.stringify({ v: 1, event: 'shutdown' }) + '\n')
    await transport.closed
    expect(transport.failure).toBeNull()
  }
})
test('forged or unbounded deadline metadata fails and releases protocol pipes', async () => {
  for (const data of [
    { deadlineProfile: 'standard', requestTimeoutMs: 30000 },
    { deadlineProfile: 'emulated-functional', requestTimeoutMs: 0 },
    { deadlineProfile: 'emulated-functional', requestTimeoutMs: 30001 },
    { deadlineProfile: 'unknown', requestTimeoutMs: 10000 },
    { requestTimeoutMs: 30000 },
    { deadlineProfile: 'standard' },
    { deadlineProfile: 'standard', requestTimeoutMs: '10000' },
  ]) {
    const input = new PassThrough(),
      output = new PassThrough()
    const transport = new NativeTransport(input, output)
    input.write(JSON.stringify({ v: 1, event: 'ready', abi: 1, data }) + '\n')
    await expect(transport.ready).rejects.toThrow('deadline profile')
    expect(input.destroyed).toBe(true)
    expect(output.destroyed).toBe(true)
  }
})

import { describe, expect, test } from 'bun:test'
import {
  handleInputRequest,
  InputSession,
} from '../../benchmarks/electrobun/app/src/bun/input-session.ts'

const nonce = 'de8327e8-225b-44ae-8c30-7b6fb950f452'

describe('Electrobun visible-input control', () => {
  test('requires readiness, one matching click and an authorized finish', () => {
    const session = new InputSession(nonce)
    expect(() => session.finish(nonce)).toThrow()
    expect(() => session.ready('wrong', [640, 720])).toThrow()
    expect(() => session.ready(nonce, [0, 720])).toThrow()
    expect(session.ready(nonce, [640, 720])).toEqual([640, 720])
    const report = { nonce, clicks: 1, label: 'Clicked', startup: { viewMountedMs: 12 } }
    session.clicked(nonce, report)
    expect(() => session.finish('wrong')).toThrow()
    expect(session.finish(nonce)).toEqual(report)
    expect(() => session.finish(nonce)).toThrow()
  })

  test('rejects malformed or duplicate click evidence without later success', () => {
    expect(() => new InputSession('not-a-uuid')).toThrow()
    const early = new InputSession(nonce)
    expect(() => early.clicked(nonce, { nonce, clicks: 1, label: 'Clicked' })).toThrow()
    expect(() => early.ready(nonce, [640, 720])).toThrow()
    const invalid = new InputSession(nonce)
    invalid.ready(nonce, [640, 720])
    expect(() => invalid.clicked(nonce, { nonce, clicks: 1, label: 'Initial' })).toThrow()
    expect(() => invalid.finish(nonce)).toThrow()
    const stale = new InputSession(nonce)
    stale.ready(nonce, [640, 720])
    expect(() => stale.clicked(nonce, { nonce: 'stale', clicks: 1, label: 'Clicked' })).toThrow()
    expect(() => stale.finish(nonce)).toThrow()
    const duplicate = new InputSession(nonce)
    duplicate.ready(nonce, [640, 720])
    duplicate.clicked(nonce, { nonce, clicks: 1, label: 'Clicked' })
    expect(() => duplicate.clicked(nonce, { nonce, clicks: 2, label: 'Clicked' })).toThrow()
    expect(() => duplicate.finish(nonce)).toThrow()
  })

  test('routes authenticated readiness, click and finish requests in order', async () => {
    const session = new InputSession(nonce)
    let ready = 0
    let finished: unknown
    const hooks = {
      ready: () => ready++,
      finish: (report: Record<string, unknown>) => (finished = report),
    }
    const post = (path: string, token: string, body = '') =>
      handleInputRequest(
        session,
        new Request(`http://127.0.0.1/${path}`, {
          method: 'POST',
          headers: { 'x-benchmark-nonce': token },
          body,
        }),
        hooks
      )
    expect((await post('input/ready', 'wrong', '[640,720]')).status).toBe(409)
    expect(ready).toBe(0)
    expect((await post('input/ready', nonce, '[640,720]')).status).toBe(200)
    expect(ready).toBe(1)
    expect((await post('input/finish', nonce)).status).toBe(409)
    expect(
      (await post('input/clicked', nonce, JSON.stringify({ nonce, clicks: 1, label: 'Clicked' })))
        .status
    ).toBe(200)
    expect((await post('input/finish', nonce)).status).toBe(200)
    expect(finished).toEqual({ nonce, clicks: 1, label: 'Clicked' })
  })

  test('the GUI smoke driver refuses non-hosted sessions before launching an app', async () => {
    const child = Bun.spawn([process.execPath, 'benchmarks/electrobun/visible-smoke-macos.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GITHUB_ACTIONS: 'false' },
    })
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit).not.toBe(0)
    expect(stderr).toContain('Hosted macOS only')
  })
})

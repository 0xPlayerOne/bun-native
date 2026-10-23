import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer } from './helpers/native-peer.ts'

async function fixture() {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    if (command.op === 'session.cookies') {
      peer.reply(command, [
        {
          name: 'token',
          value: 'private',
          domain: 'fixture.invalid',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'strict',
          expires: 2_000_000_000_000,
        },
      ])
    } else if (command.op === 'session.cookies.delete') peer.reply(command, 2)
    else if (command.op === 'session.clear')
      peer.reply(command, {
        cookiesDeleted: command.args['cookies'] ? 2 : 0,
        cacheCleared: command.args['cache'],
        storageCleared: false,
      })
    else peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  return { ...peer, backend: new CefBackend(peer.transport) }
}

test('CEF persistent sessions require and preserve an explicit absolute native root', async () => {
  const f = await fixture()
  const root = resolve('.bunly/test-profile-root')
  try {
    await assert.rejects(
      f.backend.createSession({ persistence: 'persistent', partition: 'missing-root' }),
      /persistentRoot/
    )
    await assert.rejects(
      f.backend.createSession({
        persistence: 'ephemeral',
        partition: 'unexpected-root',
        persistentRoot: root,
      }),
      /forbid/
    )
    const session = await f.backend.createSession({
      persistence: 'persistent',
      partition: 'primary',
      persistentRoot: root,
    })
    const command = f.commands.find((entry) => entry.op === 'session.create')!
    assert.deepEqual(command.args, {
      persistence: 'persistent',
      partition: 'primary',
      persistentRoot: root,
    })
    await f.backend.flushSession(session)
    await f.backend.disposeSession(session)
  } finally {
    await f.backend.dispose()
  }
})

test('CEF cookie CRUD and cache clearing use bounded portable values', async () => {
  const f = await fixture()
  try {
    const session = await f.backend.createSession({
      persistence: 'ephemeral',
      partition: 'cookie-api',
    })
    const input = {
      name: 'token',
      value: 'private',
      secure: true,
      httpOnly: true,
      sameSite: 'strict' as const,
      expires: 2_000_000_000_000,
    }
    const pending = f.backend.setCookie(session, 'https://fixture.invalid/login', input)
    input.value = 'mutated'
    await pending
    const write = f.commands.find((entry) => entry.op === 'session.cookie.set')!
    assert.equal((write.args['cookie'] as Record<string, unknown>)['value'], 'private')
    assert.deepEqual(await f.backend.cookies(session, { url: 'https://fixture.invalid/' }), [
      {
        name: 'token',
        value: 'private',
        domain: 'fixture.invalid',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        expires: 2_000_000_000_000,
      },
    ])
    assert.equal(
      await f.backend.deleteCookies(session, {
        url: 'https://fixture.invalid/',
        name: 'token',
      }),
      2
    )
    assert.deepEqual(await f.backend.clearSession(session, { cookies: true, cache: true }), {
      cookiesDeleted: 2,
      cacheCleared: true,
      storageCleared: false,
    })
    const count = f.commands.length
    await assert.rejects(
      f.backend.clearSession(session, { storage: true }),
      /session.storage-clear/
    )
    assert.equal(f.commands.length, count)
  } finally {
    await f.backend.dispose()
  }
})

test('CEF cookie requests reject credentials, excessive input and disposed sessions locally', async () => {
  const f = await fixture()
  try {
    const session = await f.backend.createSession({
      persistence: 'ephemeral',
      partition: 'cookie-validation',
    })
    await assert.rejects(
      f.backend.setCookie(session, 'https://user:secret@fixture.invalid/', {
        name: 'token',
        value: 'private',
      }),
      /credential-free/
    )
    await assert.rejects(
      f.backend.setCookie(session, 'https://fixture.invalid/', {
        name: 'x'.repeat(257),
        value: 'private',
      }),
      /name/
    )
    await assert.rejects(
      f.backend.setCookie(session, 'https://fixture.invalid/', {
        name: 'token',
        value: 'private',
        secure: 'yes',
      } as never),
      /flags/
    )
    await f.backend.disposeSession(session)
    await assert.rejects(f.backend.cookies(session), /dispos/)
  } finally {
    await f.backend.dispose()
  }
})

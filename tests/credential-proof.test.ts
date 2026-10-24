import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer } from './helpers/native-peer.ts'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifyCookieProof,
  qualifyCookieProvider,
} from '../packages/runtime/src/credential-proof.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'

const host = 'bunly-credential-proof.invalid'
const cookie = '__Host-bunly-credential-proof'
const nonce = 'a'.repeat(64)
const profileName =
  'bunly-profile-' + createHash('sha256').update('bunly-internal-credential-proof').digest('hex')
function cipher(password: string, iterations = 1003, tag = 'v10') {
  const encryptor = createCipheriv(
    'aes-128-cbc',
    pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1'),
    Buffer.alloc(16, 0x20)
  )
  return Buffer.concat([
    Buffer.from(tag),
    encryptor.update(
      Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(nonce)])
    ),
    encryptor.final(),
  ])
}
async function fixture(platform = 'darwin') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'bunly-cookie-proof-'))
  const profile = join(root, profileName)
  await mkdir(profile, { mode: 0o700 })
  const path = join(profile, 'Cookies')
  const db = new Database(path)
  db.exec(
    "CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,is_secure INTEGER,is_httponly INTEGER,is_persistent INTEGER);"
  )
  const encrypted =
    platform === 'win32'
      ? Buffer.concat([Buffer.from('v10'), Buffer.alloc(124, 17)])
      : cipher('synthetic-test-key-not-an-OS-provider', 1003, platform === 'linux' ? 'v11' : 'v10')
  db.query('INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?)').run(
    host,
    cookie,
    '/',
    '',
    encrypted,
    1,
    1,
    1
  )
  db.close(true)
  if (platform === 'win32')
    await writeFile(
      join(root, 'Local State'),
      JSON.stringify({
        os_crypt: {
          encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(64, 19)]).toString(
            'base64'
          ),
        },
      })
    )
  const proof = {
    schema: 1,
    status: 'flushed',
    provider:
      platform === 'darwin'
        ? 'macos-keychain'
        : platform === 'win32'
          ? 'windows-dpapi'
          : 'linux-secret-service',
    applicationId: 'dev.bunly.test',
    profilePath: profile,
    nonce,
    origin: `https://${host}/`,
    cookieName: cookie,
    tag: platform === 'linux' ? 'v11' : 'v10',
  }
  const mutate = (sql: string, value?: string | Uint8Array) => {
    const db = new Database(path)
    try {
      if (value === undefined) db.exec(sql)
      else db.query(sql).run(value)
    } finally {
      db.close(true)
    }
  }
  return {
    root,
    profile,
    path,
    proof,
    encrypted,
    mutate,
    close: () => rm(root, { recursive: true, force: true }),
  }
}

test('readonly verifier accepts bounded synthetic records without claiming OS qualification', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const f = await fixture(platform)
    try {
      const before = await readFile(f.path)
      const receipt = await verifyCookieProof(f.proof, f.root, platform)
      assert.equal(receipt.plaintextBytes, 0)
      assert.equal(receipt.encryptedBytes, f.encrypted.length)
      assert.equal(receipt.ciphertextSha256, createHash('sha256').update(f.encrypted).digest('hex'))
      assert.deepEqual(await readFile(f.path), before)
      assert.ok(Object.isFrozen(receipt))
    } finally {
      await f.close()
    }
  }
})
test('known fallback and mock keys cannot pass by sharing an encrypted version prefix', async () => {
  for (const platform of ['darwin', 'linux']) {
    const f = await fixture(platform)
    try {
      for (const [secret, iterations] of [
        ['peanuts', 1],
        ['', 1],
        ['peanuts', 1003],
        ['', 1003],
        ['mock_password', 1003],
      ] as const) {
        f.mutate('UPDATE cookies SET encrypted_value=?', cipher(secret, iterations, f.proof.tag))
        await assert.rejects(verifyCookieProof(f.proof, f.root, platform), {
          code: 'UNSUPPORTED_CAPABILITY',
        })
      }
    } finally {
      await f.close()
    }
  }
})
test('plaintext, wrong attributes, duplicated cookies and unknown schema fail closed', async () => {
  for (const sql of [
    "UPDATE cookies SET value='private-value'",
    "UPDATE cookies SET host_key='other.invalid'",
    "UPDATE cookies SET name='other'",
    "UPDATE cookies SET path='/other'",
    'UPDATE cookies SET is_secure=0',
    'UPDATE cookies SET is_httponly=0',
    'UPDATE cookies SET is_persistent=0',
    'DELETE FROM cookies',
    'INSERT INTO cookies SELECT * FROM cookies',
    "UPDATE meta SET value='25'",
    'INSERT INTO meta SELECT * FROM meta',
    "UPDATE cookies SET encrypted_value='not-a-blob'",
    "UPDATE cookies SET encrypted_value=X'763130'",
  ]) {
    const f = await fixture()
    try {
      f.mutate(sql)
      await assert.rejects(verifyCookieProof(f.proof, f.root, 'darwin'), {
        code: 'UNSUPPORTED_CAPABILITY',
      })
    } finally {
      await f.close()
    }
  }
})
test('native proof requires exact owner, provider, application identity and bounded schema', async () => {
  const f = await fixture()
  try {
    for (const change of [
      { provider: 'linux-secret-service' },
      { profilePath: join(f.root, 'other') },
      { nonce: 'wrong' },
      { schema: 2 },
      { applicationId: 'dev..app' },
      { applicationId: 'dev.Upper' },
      { tag: 'v11' },
      { origin: 'https://other.invalid/' },
      { cookieName: 'other' },
      { status: 'unavailable' },
      { extra: true },
    ])
      await assert.rejects(verifyCookieProof({ ...f.proof, ...change }, f.root, 'darwin'))
    await assert.rejects(verifyCookieProof(f.proof, f.root, 'unsupported'))
  } finally {
    await f.close()
  }
})
test('Windows tag alone cannot substitute for a DPAPI-wrapped root key', async () => {
  const f = await fixture('win32')
  try {
    for (const key of [
      '',
      'not-base64',
      Buffer.alloc(64).toString('base64'),
      Buffer.from('DPAPI').toString('base64'),
    ]) {
      await writeFile(
        join(f.root, 'Local State'),
        JSON.stringify({ os_crypt: { encrypted_key: key } })
      )
      await assert.rejects(verifyCookieProof(f.proof, f.root, 'win32'))
    }
  } finally {
    await f.close()
  }
})
test('ambiguous cookie stores and oversized sidecars cannot be accepted', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.profile, 'Network'))
    await writeFile(join(f.profile, 'Network/Cookies'), await readFile(f.path))
    await assert.rejects(verifyCookieProof(f.proof, f.root, 'darwin'))
    await rm(join(f.profile, 'Network/Cookies'))
    await writeFile(f.path + '-wal', Buffer.alloc(16 * 1024 * 1024 + 1))
    await assert.rejects(verifyCookieProof(f.proof, f.root, 'darwin'))
  } finally {
    await f.close()
  }
})
test.skipIf(process.platform === 'win32')(
  'linked proof stores cannot redirect verification outside the native-owned profile',
  async () => {
    const f = await fixture()
    try {
      const other = join(f.root, 'outside.db')
      await writeFile(other, await readFile(f.path))
      await rm(f.path)
      await symlink(other, f.path)
      await assert.rejects(verifyCookieProof(f.proof, f.root, 'darwin'))
    } finally {
      await f.close()
    }
  }
)
test('unavailable or malformed native proof never accepts and releases its internal context', async () => {
  const operations: string[] = []
  const channel = {
    async call(op: string) {
      operations.push(op)
      if (op === 'credentials.probe')
        return {
          ready: false,
          id: 7,
          proof: { schema: 1, status: 'unavailable', reason: 'stored-proof-unreadable' },
        }
      return null
    },
  }
  await assert.rejects(qualifyCookieProvider(channel, '/unused'), {
    code: 'UNSUPPORTED_CAPABILITY',
  })
  assert.deepEqual(operations, ['credentials.probe', 'credentials.discard'])
})
test('qualification sends only the validated canary receipt to native admission', async () => {
  const f = await fixture(process.platform)
  const operations: string[] = []
  try {
    await qualifyCookieProvider(
      {
        async call(op, args) {
          operations.push(op)
          if (op === 'credentials.probe') {
            assert.match(String(args['nonce']), /^[a-f0-9]{64}$/)
            return { ready: false, id: 7, proof: f.proof }
          }
          assert.equal(op, 'credentials.accept')
          assert.equal(args['id'], 7)
          assert.equal(args['plaintextBytes'], 0)
          assert.equal(args['nonce'], nonce)
          assert.equal(
            args['ciphertextSha256'],
            createHash('sha256').update(f.encrypted).digest('hex')
          )
          return null
        },
      },
      f.root
    )
    assert.deepEqual(operations, ['credentials.probe', 'credentials.accept'])
  } finally {
    await f.close()
  }
})
test('unsupported mock cannot silently ignore protected-cookie intent', async () => {
  const backend = new MockBackend()
  try {
    await assert.rejects(
      backend.createSession({
        partition: 'test',
        persistence: 'ephemeral',
        persistentCookies: 'os-protected',
      }),
      { code: 'UNSUPPORTED_CAPABILITY' }
    )
    assert.equal(backend.diagnostics().sessions, 0)
  } finally {
    await backend.dispose()
  }
})

test('CEF coalesces native proof and admits protected sessions only after verification', async () => {
  const f = await fixture(process.platform)
  const peer = await nativePeer()
  let next = 20,
    accepted = false
  peer.handle((command) => {
    if (command.op === 'credentials.probe')
      peer.reply(command, { ready: false, id: 7, proof: f.proof })
    else if (command.op === 'credentials.accept') {
      accepted = true
      peer.reply(command)
    } else if (command.op === 'session.create') {
      assert.equal(accepted, true)
      assert.equal(command.args['persistentCookies'], 'os-protected')
      peer.reply(command, { id: next++ })
    } else {
      peer.reply(command)
      if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
    }
  })
  const backend = new CefBackend(peer.transport)
  try {
    const sessions = await Promise.all(
      ['A', 'B'].map((partition) =>
        backend.createSession({
          persistence: 'persistent',
          partition,
          persistentRoot: f.root,
          persistentCookies: 'os-protected',
        })
      )
    )
    assert.equal(peer.commands.filter((c) => c.op === 'credentials.probe').length, 1)
    assert.equal(peer.commands.filter((c) => c.op === 'credentials.accept').length, 1)
    assert.equal(backend.diagnostics().sessions, 2)
    await Promise.all(sessions.map((session) => backend.disposeSession(session)))
  } finally {
    await backend.dispose()
    await f.close()
  }
})
test('CEF failed proof admits no application session and does not silently retry or downgrade', async () => {
  const peer = await nativePeer()
  peer.handle((command) => {
    peer.reply(
      command,
      command.op === 'credentials.probe'
        ? { ready: false, id: 7, proof: { status: 'unavailable' } }
        : null
    )
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  try {
    for (const partition of ['A', 'B'])
      await assert.rejects(
        backend.createSession({
          persistence: 'persistent',
          partition,
          persistentRoot: resolveRoot(),
          persistentCookies: 'os-protected',
        }),
        { code: 'UNSUPPORTED_CAPABILITY' }
      )
    assert.equal(peer.commands.filter((c) => c.op === 'credentials.probe').length, 1)
    assert.equal(peer.commands.filter((c) => c.op === 'credentials.discard').length, 1)
    assert.equal(peer.commands.filter((c) => c.op === 'session.create').length, 0)
    assert.equal(backend.diagnostics().sessions, 0)
  } finally {
    await backend.dispose()
  }
})
function resolveRoot() {
  return process.platform === 'win32' ? 'C:\\bunly-unused-proof' : '/bunly-unused-proof'
}

test('credential failures identify only a bounded stage, never underlying filesystem or channel details', async () => {
  const f = await fixture()
  try {
    await rm(f.path)
    await assert.rejects(verifyCookieProof(f.proof, f.root, 'darwin'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /\(database-path\)/)
      assert.ok(!error.message.includes(f.root))
      return true
    })
    await assert.rejects(
      qualifyCookieProvider(
        {
          async call() {
            throw new Error('private-canary-and-path')
          },
        },
        f.root
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /\(native-request\)/)
        assert.ok(!error.message.includes('private-canary-and-path'))
        return true
      }
    )
  } finally {
    await f.close()
  }
})

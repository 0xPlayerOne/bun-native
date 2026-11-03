/** Deterministic reporting tests, with no GC or claim about target collection. */
import { test, spyOn } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rethrowWithRetentionDiagnostic } from './retention-diagnostic.ts'

const variable = 'BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR'

function withDirectory(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-retention-report-'))
  const previous = process.env[variable]
  process.env[variable] = directory
  try {
    run(directory)
  } finally {
    if (previous === undefined) delete process.env[variable]
    else process.env[variable] = previous
    rmSync(directory, { recursive: true, force: true })
  }
}

function observations() {
  const root = {
    ready: Promise.resolve(),
    closed: Promise.resolve(),
    diagnostics: {
      nodes: 0,
      listeners: 0,
      pending: false,
      commits: 2,
      mutations: { create: 2, set: 0, insert: 2, remove: 1 },
    },
  }
  // Model supplied post-failure observations; do not force or simulate a GC run.
  const references = Array.from({ length: 10 }, (_, index) => ({
    deref: () => (index === 2 || index === 9 ? root : undefined),
  }))
  const context = {
    application: {
      diagnostics: {
        windows: 1,
        nodes: 1,
        callbacks: 0,
        queuedTransactions: 0,
        queuedCallbacks: 0,
        activeCallbacks: 0,
      },
    },
    window: { revision: 20, closed: new Promise<void>(() => {}) },
  }
  return { root, references, context }
}

test('retention metadata records survivor indexes and exact identity while rethrowing the same assertion', () => {
  withDirectory((directory) => {
    const { root, references, context } = observations()
    const original = new Error('original retained-count assertion')
    assert.throws(
      () => rethrowWithRetentionDiagnostic(original, references, context),
      (error) => error === original
    )
    const filename = `solid-retention-${process.pid}.json`
    assert.deepEqual(readdirSync(directory), [filename])
    const bytes = readFileSync(join(directory, filename))
    assert(bytes.byteLength <= 32_768)
    const report = JSON.parse(bytes.toString())
    assert.equal(report.expectedRetainedCount, 0)
    assert.equal(report.probeCount, 10)
    assert.equal(report.observedAfterFailureCount, 2)
    assert.deepEqual(
      report.survivors,
      [2, 9].map((index) => ({
        index,
        ready: 'fulfilled',
        closed: 'fulfilled',
        diagnostics: root.diagnostics,
      }))
    )
    assert.deepEqual(report.application, context.application.diagnostics)
    assert.deepEqual(report.window, { revision: 20, closed: 'pending' })
    assert.equal(report.runtime.bunRevision, Bun.revision)
    assert.equal(report.runtime.executable, process.execPath)
    assert.equal(report.platform.os, process.platform)
    assert.equal(report.platform.architecture, process.arch)
    assert.match(report.scope, /no extra collection, snapshot, await or retry/)
    assert.match(report.limitation, /not a trace of their original marking roots/)
    const source = report.source.files.find(
      (file: { path: string }) => file.path === 'tests/solid/renderer.test.ts'
    )
    const current = readFileSync(resolve(import.meta.dir, 'renderer.test.ts'))
    assert.equal(source.bytes, current.length)
    assert.equal(source.sha256, createHash('sha256').update(current).digest('hex'))
    assert.equal(report.source.files.length, 12)
    assert(
      !bytes.includes(Buffer.from(original.message)),
      'Do not persist arbitrary error contents'
    )
  })
})

test('disabled retention diagnostics never dereference a target or create an artifact', () => {
  withDirectory((directory) => {
    delete process.env[variable]
    const { context } = observations()
    const original = new Error('original assertion')
    const references = Array.from({ length: 10 }, () => ({
      deref: (): undefined => {
        throw new Error('Reporting was disabled')
      },
    }))
    assert.throws(
      () => rethrowWithRetentionDiagnostic(original, references, context),
      (error) => error === original
    )
    assert.deepEqual(readdirSync(directory), [])
  })
})

test('existing evidence is not overwritten and a write failure preserves the original assertion', () => {
  withDirectory((directory) => {
    const { references, context } = observations()
    const filename = join(directory, `solid-retention-${process.pid}.json`)
    const preserved = '{"originalEvidence":true}\n'
    writeFileSync(filename, preserved)
    const original = new Error('original assertion')
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      assert.throws(
        () => rethrowWithRetentionDiagnostic(original, references, context),
        (error) => error === original
      )
      assert.equal(readFileSync(filename, 'utf8'), preserved)
      assert.equal(errorLog.mock.calls.length, 1)
      assert.match(String(errorLog.mock.calls[0]?.[0]), /EEXIST/)
    } finally {
      errorLog.mockRestore()
    }
  })
})

test('an invalid probe bound and even a failed diagnostic logger cannot replace the original assertion', () => {
  withDirectory((directory) => {
    const { references, context } = observations()
    const original = new Error('original assertion')
    const errorLog = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('logger failed')
    })
    try {
      assert.throws(
        () => rethrowWithRetentionDiagnostic(original, [...references, references[0]!], context),
        (error) => error === original
      )
      assert.deepEqual(readdirSync(directory), [])
      assert.equal(errorLog.mock.calls.length, 1)
    } finally {
      errorLog.mockRestore()
    }
  })
})

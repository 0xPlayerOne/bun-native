/** Failure-only research preload: never changes collection or assertion outcomes. */
import { mock } from 'bun:test'
import { rethrowWithRetentionDiagnostic } from '../tests/solid/retention-diagnostic.ts'
import * as jsc from 'bun:jsc'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const diagnosticPath = resolve(import.meta.dir, '../tests/solid/retention-diagnostic.ts')
const original = rethrowWithRetentionDiagnostic
const snapshot = Reflect.get(jsc, 'generateHeapSnapshotForDebugging')
if (typeof snapshot !== 'function') throw new Error('Pinned debugging snapshot export is missing')

type Reference = { deref(): object | undefined }
function addresses(references: readonly Reference[]) {
  return references.flatMap((reference, index) => {
    const target = reference.deref()
    if (!target) return []
    const pointer = /:\s+(?:0x)?([0-9a-f]{8,16})(?:\s|$)/i.exec(jsc.jscDescribe(target))?.[1]
    if (!pointer) throw new Error('Pinned target description has no cell address')
    const address = `0x${BigInt(`0x${pointer}`).toString(16)}`
    return [{ index, address }]
  })
}

mock.module(diagnosticPath, () => ({
  rethrowWithRetentionDiagnostic(...args: Parameters<typeof original>): never {
    const [failure, references] = args
    const directory = process.env['BUN_NATIVE_RETENTION_ROOT_TRACE_DIR']
    const stack = failure instanceof Error ? (failure.stack ?? '') : ''
    if (
      directory &&
      isAbsolute(directory) &&
      /tests[/\\]solid[/\\]renderer\.test\.ts/.test(stack)
    ) {
      let phase = 'describe'
      try {
        const targets = addresses(references)
        phase = 'snapshot'
        const observed = snapshot()
        phase = 'serialize'
        const encoded = JSON.stringify(observed)
        if (Buffer.byteLength(encoded) > 256 * 1024 * 1024)
          throw new Error('Debugging snapshot exceeded its research bound')
        phase = 'write-snapshot'
        mkdirSync(directory, { recursive: true })
        const stem = `root-trace-${process.pid}`
        writeFileSync(join(directory, `${stem}.heap.json`), encoded, { flag: 'wx' })
        phase = 'source-receipt'
        const test = readFileSync(resolve(import.meta.dir, '../tests/solid/renderer.test.ts'))
        writeFileSync(
          join(directory, `${stem}.json`),
          JSON.stringify(
            {
              schemaVersion: 1,
              scope: 'Failure-only snapshot after the original Solid assertion already failed',
              limitations: [
                'Snapshot performs a collection; it is not the exact preceding mark set.',
                'Original assertion and observer dereferences protect targets during this job.',
                'Missing hidden or conservative edges are not proof of collection or root absence.',
              ],
              bunRevision: Bun.revision,
              sourceTestSha256: createHash('sha256').update(test).digest('hex'),
              snapshotSha256: createHash('sha256').update(encoded).digest('hex'),
              targets,
            },
            null,
            2
          ) + '\n',
          { flag: 'wx' }
        )
      } catch (error) {
        const errorClass =
          error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'unknown'
        console.error(
          `Failure-only retaining-path observation was unavailable (${phase}, ${errorClass})`
        )
        try {
          mkdirSync(directory, { recursive: true })
          writeFileSync(
            join(directory, `observer-error-${process.pid}.json`),
            JSON.stringify({ phase, errorClass }) + '\n',
            { flag: 'wx' }
          )
        } catch {
          // Preserve the original failure even when observer-error reporting fails.
        }
      }
    }
    // Always retain the original metadata path and rethrow the original failure.
    return original(...args)
  },
}))

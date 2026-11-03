/** Failure-only observer; preserves the original React retention assertion. */
import * as jsc from 'bun:jsc'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const directory = process.env['BUN_NATIVE_REACT_RETENTION_TRACE_DIR']
if (!directory || !isAbsolute(directory))
  throw new Error('An absolute observation directory is required')
const snapshot = Reflect.get(jsc, 'generateHeapSnapshotForDebugging')
if (typeof snapshot !== 'function') throw new Error('Pinned debugging snapshot export is missing')
const original = assert.equal
let captured = false
Reflect.set(assert, 'equal', (...args: unknown[]) => {
  let failure: unknown
  try {
    return Reflect.apply(original, assert, args)
  } catch (error) {
    failure = error
  }
  if (
    !captured &&
    args[2] === 'Disposed view/callback targets remain observable' &&
    args[0] !== args[1]
  ) {
    captured = true
    try {
      const encoded = JSON.stringify(snapshot())
      if (Buffer.byteLength(encoded) > 128 * 1024 * 1024)
        throw new Error('Diagnostic snapshot exceeds 128 MiB')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'react-root-trace.heap.json'), encoded, { flag: 'wx' })
      writeFileSync(
        join(directory, 'react-root-trace.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            scope: 'Research only: snapshot after the unchanged React assertion already failed',
            limitations: [
              'Snapshot performs another collection and does not reconstruct the preceding exact mark set.',
              'Original WeakRef predicate protects observed targets for this job.',
              'Targets are selected by React root field structure, not equated with earlier WeakRef indexes.',
              'Missing hidden or conservative edges remain unknown, not proof of collection.',
            ],
            bunRevision: Bun.revision,
            entrySha256: createHash('sha256').update(readFileSync(Bun.main)).digest('hex'),
            snapshotSha256: createHash('sha256').update(encoded).digest('hex'),
            observedCount: typeof args[0] === 'number' ? args[0] : null,
            expectedCount: typeof args[1] === 'number' ? args[1] : null,
          },
          null,
          2
        ) + '\n',
        { flag: 'wx' }
      )
    } catch (error) {
      console.error(
        'Failure-only snapshot unavailable:',
        error instanceof Error ? error.name : 'unknown'
      )
    }
  }
  throw failure
})

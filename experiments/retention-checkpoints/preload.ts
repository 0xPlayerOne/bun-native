/** Research only: original collections and assertions remain authoritative. */
import { dlopen, FFIType } from 'bun:ffi'
import { mock } from 'bun:test'
import { jscDescribe } from 'bun:jsc'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { rethrowWithRetentionDiagnostic } from '../../tests/solid/retention-diagnostic.ts'

const library = process.env['BUN_NATIVE_CHECKPOINT_LIBRARY']
const output = process.env['BUN_NATIVE_CHECKPOINT_OUTPUT_DIR']
if (!library || !output || !isAbsolute(library) || !isAbsolute(output))
  throw new Error('Research requires absolute owned library and output paths')
const native = dlopen(library, {
  capture_stack: { args: [], returns: FFIType.u32 },
  snapshot_count: { args: [], returns: FFIType.u32 },
  snapshot_valid: { args: [FFIType.u32], returns: FFIType.u32 },
  snapshot_start: { args: [FFIType.u32], returns: FFIType.u64 },
  snapshot_words: { args: [FFIType.u32], returns: FFIType.u32 },
  snapshot_truncated: { args: [FFIType.u32], returns: FFIType.u32 },
  snapshot_frames: { args: [FFIType.u32], returns: FFIType.u32 },
  snapshot_return: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
  match_count: { args: [FFIType.u32, FFIType.u64], returns: FFIType.u32 },
  match_offset: { args: [FFIType.u32, FFIType.u64, FFIType.u32], returns: FFIType.u64 },
  executable_base: { args: [], returns: FFIType.u64 },
  sentinel_control: { args: [], returns: FFIType.u32 },
  reset_snapshots: { args: [], returns: FFIType.void },
}).symbols
const control = native.sentinel_control()
if (control === 0) throw new Error('Native sentinel control did not find its live stack word')
native.reset_snapshots()
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'sentinel-control.json'), JSON.stringify({ matches: control }) + '\n', {
  flag: 'wx',
})
const active = process.env['BUN_NATIVE_CHECKPOINT_CAPTURE'] === '1'
const originalGc = Bun.gc
if (active)
  Bun.gc = (...args: Parameters<typeof Bun.gc>): ReturnType<typeof Bun.gc> => {
    native.capture_stack()
    return originalGc(...args)
  }

const original = rethrowWithRetentionDiagnostic
const path = resolve(import.meta.dir, '../../tests/solid/retention-diagnostic.ts')
mock.module(path, () => ({
  rethrowWithRetentionDiagnostic(...args: Parameters<typeof original>): never {
    const [failure, references] = args
    const stack = failure instanceof Error ? (failure.stack ?? '') : ''
    if (active && /tests[/\\]solid[/\\]renderer\.test\.ts/.test(stack)) {
      try {
        const count = native.snapshot_count()
        const checkpoints = [count - 2, count - 1].filter(
          (sequence) => sequence >= 0 && native.snapshot_valid(sequence) === 1
        )
        const survivors = references.flatMap((reference, index) => {
          const target = reference.deref()
          if (!target) return []
          const address = /:\s+(?:0x)?([0-9a-f]{8,16})(?:\s|$)/i.exec(jscDescribe(target))?.[1]
          if (!address) throw new Error('Pinned cell description lacks an address')
          const cell = BigInt(`0x${address}`)
          return [
            {
              index,
              address: `0x${cell.toString(16)}`,
              checkpoints: checkpoints.map((sequence) => {
                const matches = native.match_count(sequence, cell)
                return {
                  sequence,
                  matches,
                  offsets: Array.from({ length: Math.min(matches, 32) }, (_, occurrence) =>
                    Number(native.match_offset(sequence, cell, occurrence))
                  ),
                  matchesTruncated: matches > 32,
                }
              }),
            },
          ]
        })
        const report = {
          scope:
            'Private native stack copied before the existing GC calls; targets read only after original failure',
          limitations: [
            'A copied word is a candidate conservative edge, not proof of its writer or original mark reason.',
            'Preloading and the extra native call can affect stack shape. Original and dormant controls are separate.',
            'Only exact address matches are examined; missing or interior pointers remain unknown.',
            'The original assertion is preserved. No stack is cleared, no GC added and no raw stack uploaded.',
          ],
          bunRevision: Bun.revision,
          sourceTestSha256: createHash('sha256')
            .update(readFileSync(resolve(import.meta.dir, '../../tests/solid/renderer.test.ts')))
            .digest('hex'),
          collectionCallsObserved: count,
          executableBase: `0x${BigInt(native.executable_base()).toString(16)}`,
          checkpoints: checkpoints.map((sequence) => ({
            sequence,
            start: `0x${BigInt(native.snapshot_start(sequence)).toString(16)}`,
            words: native.snapshot_words(sequence),
            truncated: native.snapshot_truncated(sequence) !== 0,
            returns: Array.from(
              { length: native.snapshot_frames(sequence) },
              (_, index) => `0x${BigInt(native.snapshot_return(sequence, index)).toString(16)}`
            ),
          })),
          survivors,
        }
        const encoded = JSON.stringify(report, null, 2) + '\n'
        if (Buffer.byteLength(encoded) > 131072) throw new Error('Selected report exceeded bound')
        writeFileSync(join(output, `pre-gc-stack-${process.pid}.json`), encoded, { flag: 'wx' })
      } catch (error) {
        console.error(
          'Pre-collection observation unavailable:',
          error instanceof Error ? error.name : 'unknown'
        )
      }
    }
    return original(...args)
  },
}))

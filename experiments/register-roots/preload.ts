/** Research only: no changed producer, collector count, sleep or assertion. */
import { dlopen, FFIType } from 'bun:ffi'
import { mock } from 'bun:test'
import { jscDescribe } from 'bun:jsc'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { rethrowWithRetentionDiagnostic } from '../../tests/solid/retention-diagnostic.ts'

const library = process.env['BN_ROOT_CAPTURE_LIBRARY']
const output = process.env['BN_ROOT_CAPTURE_OUTPUT']
const source = process.env['BN_ROOT_CAPTURE_SOURCE']
if (!library || !output || !source || ![library, output, source].every(isAbsolute))
  throw new Error('Research requires absolute owned library, source and output paths')
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Register observer requires actual Windows x64')
const diagnosticFile = join(source, 'tests/solid/retention-diagnostic.ts')
const originalModule = (await import(pathToFileURL(diagnosticFile).href)) as {
  rethrowWithRetentionDiagnostic: typeof rethrowWithRetentionDiagnostic
}
const original = originalModule.rethrowWithRetentionDiagnostic
const native = dlopen(library, {
  capture_stack: { args: [], returns: FFIType.u32 },
  snapshot_count: { args: [], returns: FFIType.u32 },
  snapshot_valid: { args: [FFIType.u32], returns: FFIType.u32 },
  snapshot_words: { args: [FFIType.u32], returns: FFIType.u32 },
  snapshot_truncated: { args: [FFIType.u32], returns: FFIType.u32 },
  snapshot_start: { args: [FFIType.u32], returns: FFIType.u64 },
  snapshot_pc: { args: [FFIType.u32], returns: FFIType.u64 },
  match_count: { args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  match_index: {
    args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  match_delta: {
    args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  register_control: { args: [], returns: FFIType.u32 },
  stack_control: { args: [], returns: FFIType.u32 },
  reset_snapshots: { args: [], returns: FFIType.void },
}).symbols

const sentinel = 0x4b1d2876c503e9a2n
const sequence = native.register_control()
const controls = {
  sequence,
  r12Matches: native.match_count(sequence, 1, sentinel, 1),
  r12Index: native.match_index(sequence, 1, sentinel, 1, 0),
  xmm6Matches: native.match_count(sequence, 2, sentinel, 1),
  xmm6Index: native.match_index(sequence, 2, sentinel, 1, 0),
  interiorMatches: native.match_count(sequence, 1, sentinel - 5n, 16),
  interiorDelta: native.match_delta(sequence, 1, sentinel - 5n, 16, 0),
  negative: native.match_count(sequence, 1, 0x1a2b3c4d55667788n, 16),
  stackMatches: native.stack_control(),
}
if (
  sequence === 0xffff_ffff ||
  controls.r12Matches < 1 ||
  controls.r12Index !== 4 ||
  controls.xmm6Matches < 1 ||
  controls.xmm6Index !== 0 ||
  controls.interiorMatches < 1 ||
  controls.interiorDelta !== 5 ||
  controls.negative !== 0 ||
  controls.stackMatches < 1
)
  throw new Error('Native register/stack observer failed its discriminating controls')
native.reset_snapshots()
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'controls.json'), JSON.stringify(controls) + '\n', { flag: 'wx' })

const active = process.env['BN_ROOT_CAPTURE_ACTIVE'] === '1'
let invalidCaptures = 0
const originalGc = Bun.gc
if (active)
  Bun.gc = (...args: Parameters<typeof Bun.gc>): ReturnType<typeof Bun.gc> => {
    if (native.capture_stack() === 0xffff_ffff) invalidCaptures++
    return originalGc(...args)
  }

mock.module(diagnosticFile, () => ({
  rethrowWithRetentionDiagnostic(...args: Parameters<typeof original>): never {
    const [failure, references] = args
    const stack = failure instanceof Error ? (failure.stack ?? '') : ''
    if (active && /tests[/\\]solid[/\\]renderer\.test\.ts/.test(stack)) {
      try {
        const count = native.snapshot_count()
        const checkpoints = [count - 2, count - 1].filter(
          (item) => item >= 0 && native.snapshot_valid(item) === 1
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
              checkpoints: checkpoints.map((checkpoint) => ({
                checkpoint,
                banks: [0, 1, 2].map((bank) => ({
                  bank,
                  windows: [1, 16, 64, 256].map((width) => {
                    const matches = native.match_count(checkpoint, bank, cell, width)
                    return {
                      width,
                      matches,
                      truncated: matches > 32,
                      selected: Array.from({ length: Math.min(matches, 32) }, (_, occurrence) => ({
                        index: native.match_index(checkpoint, bank, cell, width, occurrence),
                        delta: native.match_delta(checkpoint, bank, cell, width, occurrence),
                      })),
                    }
                  }),
                })),
              })),
            },
          ]
        })
        const report = {
          scope:
            'Own-process pre-GC stack and restored caller nonvolatile register candidates; not collector marking provenance',
          limitations: [
            'The extra preload/native call changes layout. Compare independent original and dormant controls.',
            'Windows unwind restores our C frame only; volatile registers, JIT frames, other threads and hidden heap owners are not traced.',
            'Widths greater than one are address windows, not verified cell sizes. Nearby unrelated cells may match.',
            'Register or stack matches do not prove a collector used that value. Missing matches do not exclude runtime or ordinary ownership.',
            'No raw stack/register buffers are published. Targets are inspected only after the original assertion fails.',
          ],
          bunRevision: Bun.revision,
          sourceTestSha256: createHash('sha256')
            .update(readFileSync(join(source, 'tests/solid/renderer.test.ts')))
            .digest('hex'),
          collectionCallsObserved: count,
          invalidCaptures,
          gprNames: ['RBX', 'RBP', 'RDI', 'RSI', 'R12', 'R13', 'R14', 'R15'],
          simdWords: 'XMM6 through XMM15, two little-endian 64-bit words each',
          checkpoints: checkpoints.map((checkpoint) => ({
            sequence: checkpoint,
            start: `0x${BigInt(native.snapshot_start(checkpoint)).toString(16)}`,
            callerPc: `0x${BigInt(native.snapshot_pc(checkpoint)).toString(16)}`,
            stackWords: native.snapshot_words(checkpoint),
            stackTruncated: native.snapshot_truncated(checkpoint) !== 0,
          })),
          survivors,
        }
        const encoded = JSON.stringify(report, null, 2) + '\n'
        if (Buffer.byteLength(encoded) > 262_144) throw new Error('Selected report exceeded bound')
        writeFileSync(join(output, `register-roots-${process.pid}.json`), encoded, { flag: 'wx' })
      } catch (error) {
        console.error(
          'Register observation unavailable:',
          error instanceof Error ? error.name : 'unknown'
        )
      }
    }
    return original(...args)
  },
}))

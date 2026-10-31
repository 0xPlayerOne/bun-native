/** Failure metadata only. This neither collects garbage nor identifies a marking root. */
import type { NativeApplication, NativeWindow } from '@bun-native/core'
import type { RenderRoot } from '@bun-native/renderer'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join, resolve } from 'node:path'

type Root = Pick<RenderRoot, 'diagnostics' | 'ready' | 'closed'>
type Reference = Pick<WeakRef<Root>, 'deref'>
type Context = {
  application: Pick<NativeApplication, 'diagnostics'>
  window: Pick<NativeWindow, 'revision' | 'closed'>
}

const sourcePaths = [
  'tests/solid/renderer.test.ts',
  'tests/solid/retention-diagnostic.ts',
  'tests/renderers/support.ts',
  'packages/renderer/src/root.ts',
  'packages/renderer/src/window-lifetime.ts',
  'packages/solid/src/mount.ts',
  'packages/core/src/application.ts',
  'packages/runtime/src/index.ts',
  'bunfig.toml',
  'package.json',
  'bun.lock',
  'toolchain.json',
] as const

function sourceIdentity() {
  const repository = resolve(import.meta.dir, '../..')
  return sourcePaths.map((path) => {
    const file = join(repository, path)
    if (statSync(file).size > 262_144) throw new RangeError('Diagnostic source file exceeds bound')
    const bytes = readFileSync(file)
    if (bytes.length > 262_144) throw new RangeError('Diagnostic source file exceeds bound')
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
}

/** Synchronous catch path: preserve the original assertion even if reporting fails. */
export function rethrowWithRetentionDiagnostic(
  originalFailure: unknown,
  references: readonly Reference[],
  context: Context
): never {
  try {
    const directory = process.env['BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR']
    if (directory) {
      if (references.length !== 10) throw new RangeError('Expected exactly ten retention probes')
      const survivors = references.flatMap((reference, index) => {
        const root = reference.deref()
        if (!root) return []
        const state = root.diagnostics
        return [
          {
            index,
            ready: Bun.peek.status(root.ready),
            closed: Bun.peek.status(root.closed),
            diagnostics: {
              nodes: state.nodes,
              listeners: state.listeners,
              pending: state.pending,
              commits: state.commits,
              mutations: {
                create: state.mutations.create,
                set: state.mutations.set,
                insert: state.mutations.insert,
                remove: state.mutations.remove,
              },
            },
          },
        ]
      })
      const state = context.application.diagnostics
      const report = {
        schemaVersion: 1,
        scope:
          'Failure-only metadata after the original ten-root WeakRef assertion; no extra collection, snapshot, await or retry.',
        limitation:
          'The original predicate and this diagnostic dereference keep observed targets alive for the current job. This is not a trace of their original marking roots or proof of framework leakage.',
        recordedAt: new Date().toISOString(),
        expectedRetainedCount: 0,
        probeCount: references.length,
        observedAfterFailureCount: survivors.length,
        survivors,
        application: {
          windows: state.windows,
          nodes: state.nodes,
          callbacks: state.callbacks,
          queuedTransactions: state.queuedTransactions,
          queuedCallbacks: state.queuedCallbacks,
          activeCallbacks: state.activeCallbacks,
        },
        window: {
          revision: context.window.revision,
          closed: Bun.peek.status(context.window.closed),
        },
        runtime: {
          bunVersion: Bun.version,
          bunRevision: Bun.revision,
          executable: process.execPath,
        },
        platform: { os: process.platform, architecture: process.arch, release: release() },
        source: {
          declaredGitHubSha: /^[0-9a-f]{40,64}$/.test(process.env['GITHUB_SHA'] ?? '')
            ? process.env['GITHUB_SHA']
            : null,
          files: sourceIdentity(),
        },
      }
      const encoded = JSON.stringify(report, null, 2) + '\n'
      if (Buffer.byteLength(encoded) > 32_768)
        throw new RangeError('Retention report exceeds bound')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `solid-retention-${process.pid}.json`), encoded, {
        flag: 'wx',
        mode: 0o600,
      })
    }
  } catch (error) {
    try {
      const code =
        error instanceof Error && 'code' in error ? String(error.code).slice(0, 32) : 'unavailable'
      console.error(`Bun Native retention diagnostic could not be written (${code})`)
    } catch {
      // A diagnostic/logging failure must never replace the original assertion.
    }
  }
  throw originalFailure
}

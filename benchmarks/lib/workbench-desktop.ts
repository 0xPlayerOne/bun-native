/** Compose the shared renderer workload with revision readiness, never a native bridge. */
import { randomBytes } from 'node:crypto'
import { createFixtureServer, type FixtureAssets } from '../fixtures/server.ts'
import { fixtureBytes, checksum } from '../fixtures/data.ts'
import { createDesktopProbe, type DesktopObservation, type DesktopProbe } from './desktop-probe.ts'

export interface WorkbenchCompletion {
  readonly scenario: 'terminal-render'
  readonly passed: true
  readonly nativeGlobalsAbsent: true
  readonly bytes: number
  readonly checksum: number
  readonly terminalConsumedThenTwoFramesMs: number
}

export function verifyWorkbenchCompletion(input: unknown): WorkbenchCompletion {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Missing shared workbench completion')
  const value = input as Record<string, unknown>
  const expected = fixtureBytes()
  if (
    value['scenario'] !== 'terminal-render' ||
    value['passed'] !== true ||
    value['nativeGlobalsAbsent'] !== true ||
    value['bytes'] !== expected.length ||
    value['checksum'] !== checksum(expected) ||
    typeof value['terminalConsumedThenTwoFramesMs'] !== 'number' ||
    !Number.isFinite(value['terminalConsumedThenTwoFramesMs']) ||
    value['terminalConsumedThenTwoFramesMs'] < 0
  )
    throw new Error('Shared terminal workload was incomplete or invalid')
  // Do not retain arbitrary page content, supplied URLs, tokens, or unknown fields.
  return Object.freeze({
    scenario: 'terminal-render',
    passed: true,
    nativeGlobalsAbsent: true,
    bytes: expected.length,
    checksum: checksum(expected),
    terminalConsumedThenTwoFramesMs: value['terminalConsumedThenTwoFramesMs'],
  })
}

export interface WorkbenchDesktopObservation extends DesktopObservation {
  readonly workbench: WorkbenchCompletion
}
export interface WorkbenchDesktopProbe extends Omit<DesktopProbe, 'completion'> {
  readonly completion: Promise<WorkbenchDesktopObservation>
}

/** Both frameworks receive the same xterm/UI assets. The nested preview remains an iframe. */
export async function createWorkbenchDesktopProbe(
  options: Parameters<typeof createDesktopProbe>[0],
  assets: FixtureAssets
): Promise<WorkbenchDesktopProbe> {
  for (const name of ['html', 'script', 'terminalJs', 'terminalCss'] as const) {
    if (typeof assets[name] !== 'string' || !assets[name]?.length)
      throw new Error(
        'Install the complete shared workbench assets; no renderer substitute is accepted'
      )
  }
  const token = randomBytes(24).toString('hex')
  const fixture = await createFixtureServer(assets, {
    completion: { token, scenario: 'terminal-render', timeoutMs: 22000 },
  })
  const url = fixture.origin + '/?scenario=terminal-render&completionToken=' + token
  // Origins/tokens are generated locally and contain no HTML metacharacters. Do
  // not interpolate a user-provided URL or relax the base probe's frame policy.
  const frame = `<iframe id="shared-workbench" title="Shared terminal and browser workload" width="1120" height="760" sandbox="allow-scripts allow-same-origin allow-forms" src="${url}"></iframe>`
  const html = options.html.includes('</body>')
    ? options.html.replace('</body>', frame + '</body>')
    : options.html + frame
  let probe: DesktopProbe
  try {
    probe = await createDesktopProbe({ ...options, html, frameOrigin: fixture.origin })
  } catch (error) {
    await fixture.close()
    throw error
  }
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('Shared workbench readiness deadline')),
    options.timeoutMs ?? 20000
  )
  let closing: Promise<void> | undefined
  function stopWorkload(): void {
    controller.abort(new Error('Shared workbench stopped'))
    clearTimeout(timeout)
  }
  const workbench = (async () => {
    const response = await fetch(fixture.origin + '/__benchmark/completion', {
      headers: { 'x-benchmark-token': token },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('Shared workbench did not complete: ' + response.status)
    return verifyWorkbenchCompletion(await response.json())
  })()
  const completion = Promise.all([probe.completion, workbench])
    .then(
      ([observation, result]) => Object.freeze({ ...observation, workbench: result }),
      (error) => {
        probe.requestQuit()
        stopWorkload()
        throw error
      }
    )
    .finally(() => clearTimeout(timeout))
  void completion.catch(() => {})
  return {
    configuration: Object.freeze({ ...probe.configuration, workbenchOrigin: fixture.origin }),
    completion,
    requestIdle(milliseconds) {
      probe.requestIdle(milliseconds)
    },
    requestQuit() {
      stopWorkload()
      probe.requestQuit()
    },
    close() {
      if (!closing) {
        stopWorkload()
        closing = (async () => {
          const results = await Promise.allSettled([probe.close(), fixture.close()])
          // Rejections are observed before fixture teardown finishes, including
          // the aborted in-flight completion GET. No hidden fetch survives close.
          await workbench.catch(() => {})
          const errors = results
            .filter((row): row is PromiseRejectedResult => row.status === 'rejected')
            .map((row) => row.reason)
          if (errors.length) throw new AggregateError(errors, 'Shared fixture cleanup failed')
        })()
      }
      return closing
    },
  }
}

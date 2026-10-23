/**
 * The shared backend contract suite.
 *
 * Every backend - the mock, CEF and each system-webview adapter - is measured
 * against the same portable semantics: resource ownership, RPC authority,
 * navigation, profiles (trust), permissions, supported actions and reload
 * behaviour. The suite only uses the browser-independent contract, so it never
 * depends on a native transport, and a check the backend cannot answer is
 * reported as skipped with its reason instead of being passed or failed.
 */
import { BunlyError, originOf } from '../../contracts/src/index.ts'
import type {
  BrowserBackend,
  BackendName,
  ViewHandle,
  WindowHandle,
} from '../../contracts/src/index.ts'
import { RpcViewAuthority, claimRpcAuthority } from './rpc-authority.ts'

export type ConformanceArea =
  | 'resource-ownership'
  | 'rpc-authority'
  | 'navigation'
  | 'profiles'
  | 'permissions'
  | 'supported-actions'
  | 'reload'

export type ConformanceStatus = 'pass' | 'fail' | 'skipped'

export interface ConformanceCheck {
  readonly area: ConformanceArea
  readonly name: string
  readonly status: ConformanceStatus
  /** Why the check failed or was skipped. Never a claim of success. */
  readonly detail?: string
}

export interface ConformanceReport {
  readonly backend: BackendName
  readonly capabilityVersion: number
  readonly checks: readonly ConformanceCheck[]
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

export interface ConformanceOptions {
  readonly applicationOrigin?: string
  readonly applicationUrl?: string
  readonly remoteUrl?: string
}

const DEFAULT_ORIGIN = 'https://app.test'
const DEFAULT_APPLICATION_URL = 'https://app.test/index.html'
const DEFAULT_REMOTE_URL = 'https://remote.test/page'

function isBunlyCode(error: unknown, code: string): boolean {
  return error instanceof BunlyError && error.code === code
}

async function expectRejection(
  operation: () => Promise<unknown>,
  code: string
): Promise<string | undefined> {
  try {
    await operation()
    return `expected ${code}, the operation resolved`
  } catch (error) {
    if (isBunlyCode(error, code)) return undefined
    return `expected ${code}, got ${(error as Error)?.name ?? 'unknown'}: ${(error as Error)?.message ?? ''}`
  }
}

/** A check that needs a capability the backend does not advertise. */
function unsupported(backend: BrowserBackend, capability: string): string | undefined {
  return backend.descriptor.capabilities.includes(capability as never)
    ? undefined
    : `${backend.descriptor.name} does not implement ${capability}`
}

export async function runBackendConformance(
  backend: BrowserBackend,
  options: ConformanceOptions = {}
): Promise<ConformanceReport> {
  const origin = options.applicationOrigin ?? DEFAULT_ORIGIN
  const applicationUrl = options.applicationUrl ?? DEFAULT_APPLICATION_URL
  const remoteUrl = options.remoteUrl ?? DEFAULT_REMOTE_URL
  const checks: ConformanceCheck[] = []
  const record = (area: ConformanceArea, name: string, detail: string | undefined): void => {
    checks.push(
      Object.freeze({ area, name, status: detail ? 'fail' : 'pass', ...(detail ? { detail } : {}) })
    )
  }
  const skip = (area: ConformanceArea, name: string, detail: string): void => {
    checks.push(Object.freeze({ area, name, status: 'skipped', detail }))
  }

  const session = await backend.createSession({
    persistence: 'ephemeral',
    partition: 'conformance',
  })
  let ownedWindow: WindowHandle | undefined
  try {
    const window = await backend.createWindow({
      title: 'Conformance',
      bounds: { x: 0, y: 0, width: 320, height: 240 },
    })
    ownedWindow = window
    const remoteView = await backend.createView({
      window,
      session,
      url: remoteUrl,
      trust: { kind: 'remote' },
    })

    // Resource ownership.
    {
      const disposable = await backend.createView({
        window,
        session,
        url: remoteUrl,
        trust: { kind: 'remote' },
      })
      await backend.disposeView(disposable)
      let detail: string | undefined
      try {
        backend.state(disposable)
        detail = 'a disposed view still answered'
      } catch (error) {
        if (!isBunlyCode(error, 'DISPOSED'))
          detail = `expected DISPOSED, got ${(error as Error)?.name}: ${(error as Error)?.message}`
      }
      record('resource-ownership', 'a disposed view cannot be reused', detail)
    }
    {
      const foreign = await backend.createSession({
        persistence: 'ephemeral',
        partition: 'foreign',
      })
      let detail: string | undefined
      try {
        backend.state(foreign as never)
        detail = 'a foreign handle was accepted'
      } catch (error) {
        if (!isBunlyCode(error, 'INVALID_HANDLE'))
          detail = `expected INVALID_HANDLE, got ${(error as Error)?.name}: ${(error as Error)?.message}`
      }
      record('resource-ownership', 'a foreign handle is rejected', detail)
      await backend.disposeSession(foreign)
    }
    {
      const detail = await expectRejection(() => backend.disposeSession(session), 'RESOURCE_IN_USE')
      record('resource-ownership', 'a session with live views is not disposable', detail)
    }

    // Navigation.
    {
      const before = backend.state(remoteView)
      const after = await backend.navigate(remoteView, 'https://remote.test/next')
      const detail =
        after.url === 'https://remote.test/next' && after.documentId !== before.documentId
          ? undefined
          : `navigation did not produce a new document (${after.url})`
      record('navigation', 'navigation produces a new document', detail)
    }
    {
      const detail = await expectRejection(
        () => backend.navigate(remoteView, 'not-a-url'),
        'INVALID_ARGUMENT'
      )
      record('navigation', 'an invalid URL is rejected', detail)
    }

    // Profiles (trust).
    {
      const detail = await expectRejection(
        () =>
          backend.createView({
            window,
            session,
            url: 'https://other.test/index.html',
            trust: { kind: 'application', origin },
          }),
        'PERMISSION_DENIED'
      )
      record('profiles', 'an application view must match its declared origin', detail)
    }
    {
      let applicationView: ViewHandle | undefined
      let detail: string | undefined
      try {
        applicationView = await backend.createView({
          window,
          session,
          url: applicationUrl,
          trust: { kind: 'application', origin: originOf(applicationUrl) },
        })
        const state = await backend.navigate(applicationView, 'https://elsewhere.test/page')
        if (state.trust.kind !== 'remote')
          detail = `expected the trust to downgrade to remote, got ${state.trust.kind}`
      } catch (error) {
        detail = `unexpected failure: ${(error as Error)?.name}: ${(error as Error)?.message}`
      }
      record('profiles', 'navigating away downgrades an application grant', detail)
      if (applicationView) await backend.disposeView(applicationView)
    }

    // Permissions.
    {
      if (unsupported(backend, 'permission.request')) {
        const detail = await expectRejection(
          () => backend.requestPermission(remoteView, 'geolocation'),
          'UNSUPPORTED_CAPABILITY'
        )
        record('permissions', 'an unsupported permission request fails clearly', detail)
      } else {
        skip(
          'permissions',
          'an unsupported permission request fails clearly',
          `${backend.descriptor.name} implements permission.request, so the unsupported path cannot be exercised`
        )
        let detail: string | undefined
        try {
          const answer = await backend.requestPermission(remoteView, 'geolocation')
          if (answer !== 'granted' && answer !== 'denied')
            detail = `unexpected permission answer ${String(answer)}`
        } catch (error) {
          detail = `unexpected failure: ${(error as Error)?.name}: ${(error as Error)?.message}`
        }
        record('permissions', 'a supported permission request answers granted or denied', detail)
      }
    }

    // Supported actions.
    {
      if (unsupported(backend, 'view.snapshot')) {
        const detail = await expectRejection(
          () => backend.snapshot(remoteView),
          'UNSUPPORTED_CAPABILITY'
        )
        record(
          'supported-actions',
          'an unsupported action fails instead of silently succeeding',
          detail
        )
      } else {
        skip(
          'supported-actions',
          'an unsupported action fails instead of silently succeeding',
          `${backend.descriptor.name} implements view.snapshot, so the unsupported path cannot be exercised`
        )
        let detail: string | undefined
        try {
          const bytes = await backend.snapshot(remoteView)
          if (!(bytes instanceof Uint8Array)) detail = 'snapshot did not return bytes'
        } catch (error) {
          detail = `unexpected failure: ${(error as Error)?.name}: ${(error as Error)?.message}`
        }
        record('supported-actions', 'a supported action returns its documented shape', detail)
      }
    }

    // Reload behaviour: reloading keeps the view but replaces its document.
    {
      const before = backend.state(remoteView)
      const after = await backend.navigate(remoteView, before.url)
      const detail =
        after.documentId !== before.documentId && after.url === before.url
          ? undefined
          : 'reloading did not replace the document'
      record('reload', 'reloading the same URL replaces the document', detail)
    }

    // RPC authority.
    {
      const authority = new RpcViewAuthority(backend, [originOf(applicationUrl)])
      let detail: string | undefined
      try {
        const document = backend.state(remoteView)
        authority.issue(
          remoteView,
          {
            frameId: 'frame-1',
            documentId: document.documentId,
            mainFrame: true,
          },
          ['app.read']
        )
        detail = 'a remote document was granted RPC authority'
      } catch (error) {
        if ((error as { code?: string })?.code !== 'FORBIDDEN')
          detail = `expected FORBIDDEN, got ${(error as Error)?.name}: ${(error as Error)?.message}`
      }
      record('rpc-authority', 'a remote document is refused RPC authority', detail)
      authority.dispose()
    }
    {
      const authority = new RpcViewAuthority(backend, [originOf(applicationUrl)])
      let detail: string | undefined
      try {
        const applicationView = await backend.createView({
          window,
          session,
          url: applicationUrl,
          trust: { kind: 'application', origin: originOf(applicationUrl) },
        })
        const document = backend.state(applicationView)
        const lease = authority.issue(
          applicationView,
          {
            frameId: 'frame-1',
            documentId: document.documentId,
            mainFrame: true,
          },
          ['app.read']
        )
        const guard = claimRpcAuthority(lease)
        guard.check('app.read')
        try {
          claimRpcAuthority(lease)
          detail = 'the same lease was claimed twice'
        } catch (error) {
          if ((error as { code?: string })?.code !== 'FORBIDDEN')
            detail = `expected FORBIDDEN on reuse, got ${(error as Error)?.name}`
        }
        await backend.disposeView(applicationView)
      } catch (error) {
        detail = `unexpected failure: ${(error as Error)?.name}: ${(error as Error)?.message}`
      }
      record('rpc-authority', 'RPC authority is granted once and cannot be reused', detail)
      authority.dispose()
    }

    const passed = checks.filter((check) => check.status === 'pass').length
    const failed = checks.filter((check) => check.status === 'fail').length
    const skipped = checks.filter((check) => check.status === 'skipped').length
    return Object.freeze({
      backend: backend.descriptor.name,
      capabilityVersion: backend.descriptor.capabilityVersion,
      checks: Object.freeze(checks),
      passed,
      failed,
      skipped,
    })
  } finally {
    // The caller retains the backend. Release only this run's resources, including
    // partial setup and unexpected backend failures, before allowing another run.
    try {
      if (ownedWindow) await backend.closeWindow(ownedWindow)
    } finally {
      await backend.disposeSession(session)
    }
  }
}

/** A one-line summary that never claims more than the checks did. */
export function summarizeConformance(report: ConformanceReport): string {
  const areas = [...new Set(report.checks.map((check) => check.area))].sort()
  const detail = areas
    .map((area) => {
      const scoped = report.checks.filter((check) => check.area === area)
      const failed = scoped.filter((check) => check.status === 'fail').length
      const skipped = scoped.filter((check) => check.status === 'skipped').length
      return `${area}:${scoped.length - failed - skipped}/${scoped.length - skipped}${
        skipped ? ` (${skipped} skipped)` : ''
      }${failed ? ` (${failed} failed)` : ''}`
    })
    .join(' ')
  return `${report.backend} capability metadata v${report.capabilityVersion} ${detail}`
}

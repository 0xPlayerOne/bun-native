/** Test-only environment selection; never installs dependencies or changes application PATH. */
import { join, resolve } from 'node:path'

export function testPython(
  root: string,
  platform: string,
  configured: string | undefined,
  activeEnvironment: string | undefined,
  executable: (path: string) => string | null = Bun.which
): string | undefined {
  // An explicit interpreter remains authoritative, including an invalid setting
  // that must fail rather than silently selecting another Python environment.
  if (configured !== undefined) return configured
  const environment = activeEnvironment ?? join(root, '.venv')
  const candidate =
    platform === 'win32'
      ? join(environment, 'Scripts', 'python.exe')
      : join(environment, 'bin', 'python')
  // Preserve the virtualenv entrypoint, not its realpath: Python uses that path
  // to find pyvenv.cfg and the contributor dependencies installed in the venv.
  if (executable(candidate)) return candidate
  return undefined
}

const selected = testPython(
  resolve(import.meta.dir, '..'),
  process.platform,
  process.env['PYTHON'],
  process.env['VIRTUAL_ENV']
)
if (selected !== undefined) process.env['PYTHON'] = selected

/** Run before launching the clipboard fixture, never inside a runtime API. */
export function requireDisposableClipboardRunner(options: {
  readonly optIn: string | undefined
  readonly platform: string
  readonly arch: string
  readonly environment: Readonly<Record<string, string | undefined>>
}): 'darwin-arm64' | 'win32-x64' {
  const { environment, platform, arch } = options
  const target = `${platform}-${arch}`
  if (
    options.optIn !== '--disposable-clipboard' ||
    environment['GITHUB_ACTIONS'] !== 'true' ||
    environment['RUNNER_ENVIRONMENT'] !== 'github-hosted' ||
    !/^[1-9][0-9]{0,19}$/.test(environment['GITHUB_RUN_ID'] ?? '') ||
    !(
      (target === 'darwin-arm64' && environment['RUNNER_OS'] === 'macOS') ||
      (target === 'win32-x64' && environment['RUNNER_OS'] === 'Windows')
    )
  )
    throw new Error(
      'Clipboard qualification requires --disposable-clipboard on a disposable GitHub-hosted macOS ARM64 or Windows x64 session'
    )
  return target as 'darwin-arm64' | 'win32-x64'
}

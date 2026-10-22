import { spawnSync } from 'node:child_process'

export interface SourceIdentity {
  readonly commit: string | null
  readonly clean: boolean
  readonly reason: 'clean-checkout' | 'dirty-checkout' | 'unavailable'
}
/** Read-only source attestation. Never trust a CI environment SHA over the worktree. */
export function sourceIdentity(directory: string): SourceIdentity {
  const options = {
    cwd: directory,
    encoding: 'utf8' as const,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], options)
  const commit = head.stdout?.trim()
  if (head.error || head.status !== 0 || !commit || !/^[a-f0-9]{40}$/.test(commit)) {
    return { commit: null, clean: false, reason: 'unavailable' }
  }
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], options)
  if (status.error || status.status !== 0) return { commit, clean: false, reason: 'unavailable' }
  if (status.stdout.length) return { commit, clean: false, reason: 'dirty-checkout' }
  // Detect a branch/head replacement while the status observation was collected.
  const after = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], options)
  if (after.error || after.status !== 0 || after.stdout.trim() !== commit)
    return { commit: null, clean: false, reason: 'unavailable' }
  return { commit, clean: true, reason: 'clean-checkout' }
}

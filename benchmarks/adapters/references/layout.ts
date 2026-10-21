import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { ReferenceName } from './packages.ts'
export interface ReferenceArtifact {
  readonly kind: 'application-directory' | 'standalone-executable'
  readonly application: string
  readonly executable: string
}
export function referenceArtifactPath(name: ReferenceName, platform: string): string {
  if (!['darwin', 'linux', 'win32'].includes(platform))
    throw new Error('Unsupported reference target')
  if (name === 'butter') return 'dist/bunlyreference' + (platform === 'win32' ? '.exe' : '')
  if (name !== 'mirin') throw new Error('Unknown reference')
  return platform === 'darwin' ? 'build/BunlyReference.app' : 'build/BunlyReference'
}
export async function referenceArtifact(
  name: ReferenceName,
  project: string
): Promise<ReferenceArtifact> {
  const path = join(project, referenceArtifactPath(name, process.platform)),
    info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error('Generated reference artifact may not be a link')
  if (name === 'butter') {
    if (!info.isFile() || !info.size) throw new Error('Missing compiled Butter executable')
    return { kind: 'standalone-executable', application: path, executable: path }
  }
  if (!info.isDirectory()) throw new Error('Missing Mirin application directory')
  let executable: string
  if (process.platform === 'darwin') {
    const plist = Bun.spawnSync(
      [
        '/usr/libexec/PlistBuddy',
        '-c',
        'Print :CFBundleExecutable',
        join(path, 'Contents/Info.plist'),
      ],
      { timeout: 5000 }
    )
    const stem = plist.stdout.toString().trim()
    if (plist.exitCode !== 0 || !stem || basename(stem) !== stem)
      throw new Error('Invalid Mirin bundle entry')
    executable = join(path, 'Contents/MacOS', stem)
  } else executable = join(path, 'BunlyReference' + (process.platform === 'win32' ? '.exe' : ''))
  const real = await realpath(executable),
    delta = relative(await realpath(path), real)
  if (
    delta === '..' ||
    delta.startsWith('../') ||
    delta.startsWith('..\\') ||
    isAbsolute(delta) ||
    !(await lstat(real)).isFile()
  )
    throw new Error('Invalid or escaping Mirin entry')
  return { kind: 'application-directory', application: path, executable: real }
}

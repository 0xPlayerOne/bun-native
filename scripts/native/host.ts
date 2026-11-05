import { constants } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { hasExecutableHeader } from './host-header.ts'

export async function prebuiltHost(path: string | undefined): Promise<string> {
  if (!path || !isAbsolute(path))
    throw new Error(
      '--host must be an absolute path to an existing prebuilt native host; this command never runs Cargo or downloads a host'
    )
  const host = await realpath(path)
  if (!(await stat(host)).isFile()) throw new Error('The prebuilt native host must be a file')
  await access(host, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK))
  const file = await open(host, 'r')
  try {
    if (!(await hasExecutableHeader(file, { platform: process.platform, arch: process.arch })))
      throw new Error(`Prebuilt host must be a ${process.platform}/${process.arch} executable`)
  } finally {
    await file.close()
  }
  return host
}

import { isAbsolute, relative, sep } from 'node:path'

export function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Package-set filenames are portable archive paths, never platform-specific paths. */
export function packagePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_@./-]+$/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

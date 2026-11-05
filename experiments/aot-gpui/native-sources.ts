/** Enumerate native workspace sources and local dependency compile inputs. */
export async function nativeSourcePaths(source: string): Promise<string[]> {
  const paths = new Set<string>()
  // Keep the different-depth alternatives separate: the pinned Bun glob engine
  // silently returns no matches for native/*/{Cargo.toml,src/**/*.rs}.
  for (const pattern of [
    'native/*/Cargo.toml',
    'native/*/src/**/*.rs',
    'native/vendor/*/Cargo.toml',
    'native/vendor/*/build.rs',
    'native/vendor/*/src/**/*',
  ]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: source })) {
      paths.add(path.replaceAll('\\', '/'))
    }
  }
  return [...paths].sort()
}

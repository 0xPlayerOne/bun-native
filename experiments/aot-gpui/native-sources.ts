/** Enumerate every native workspace crate manifest and Rust source. */
export async function nativeSourcePaths(source: string): Promise<string[]> {
  const paths = new Set<string>()
  // Keep the different-depth alternatives separate: the pinned Bun glob engine
  // silently returns no matches for native/*/{Cargo.toml,src/**/*.rs}.
  for (const pattern of ['native/*/Cargo.toml', 'native/*/src/**/*.rs']) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: source })) {
      paths.add(path.replaceAll('\\', '/'))
    }
  }
  return [...paths].sort()
}

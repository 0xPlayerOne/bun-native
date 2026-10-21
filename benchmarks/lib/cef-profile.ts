/** Explicit qualification-only profile; never inferred from the OS or a failed run. */
export function cefQualificationOptions(args: readonly string[]) {
  if (
    args.length < 1 ||
    args.length > 2 ||
    !args[0] ||
    (args.length === 2 && args[1] !== '--emulated-functional')
  ) {
    throw new Error('Pass a prebuilt runtime and optional --emulated-functional')
  }
  const emulated = args.length === 2
  return Object.freeze({
    artifact: args[0],
    emulated,
    profile: emulated ? 'emulated-functional' : 'standard',
    processTimeoutMs: emulated ? 300000 : 60000,
    pageTimeoutMs: emulated ? 60000 : 10000,
  })
}
export function qualificationConfig(config: unknown, emulated: boolean): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid runtime config')
  const value = config as Record<string, unknown>
  if (value['qualification_profile'] !== undefined)
    throw new Error('Source prebuild already has a qualification profile')
  return emulated ? { ...value, qualification_profile: 'emulated-functional' } : { ...value }
}

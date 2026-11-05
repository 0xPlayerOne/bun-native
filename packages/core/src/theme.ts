import type { Style } from '@bun-native/protocol'

/**
 * Named design values. Tokens resolve to plain numbers in JavaScript before a
 * batch is staged: the native host never sees a token, so switching themes is
 * an ordinary property update that every adapter commits the same way.
 */
export interface ThemeTokens {
  /** Unsigned 24-bit RGB. */
  readonly colors: Readonly<Record<string, number>>
  /** Logical pixels for `gap` and `padding`. */
  readonly space: Readonly<Record<string, number>>
  /** Logical pixels for `corner_radius`. */
  readonly radii: Readonly<Record<string, number>>
  /** Logical pixels for `font_size`. */
  readonly fontSizes: Readonly<Record<string, number>>
}

const groups = {
  background: 'colors',
  color: 'colors',
  border_color: 'colors',
  gap: 'space',
  padding: 'space',
  corner_radius: 'radii',
  font_size: 'fontSizes',
} as const satisfies Partial<Record<keyof Style, keyof ThemeTokens>>
type TokenField = keyof typeof groups
type Token<T extends ThemeTokens, F extends TokenField> = Extract<
  keyof T[(typeof groups)[F]],
  string
>

/** A style whose color, spacing, radius and font-size fields may name tokens. */
export type ThemedStyle<T extends ThemeTokens> = {
  [K in keyof Style]?: K extends TokenField ? number | Token<T, K> : Style[K]
}
/** The resolved style keeps every literal non-token field, such as `overflow`. */
export type ResolvedStyle<S> = { [K in keyof S]: K extends TokenField ? number : S[K] }

export interface Theme<T extends ThemeTokens = ThemeTokens> {
  readonly tokens: T
  /** Replace token names with numbers; unknown names throw before staging. */
  style<const S extends ThemedStyle<T>>(style: S): ResolvedStyle<S>
}

function check(group: keyof ThemeTokens, name: string, value: unknown): void {
  const valid =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    (group !== 'colors' || (Number.isInteger(value) && value <= 0xff_ffff))
  if (!valid) throw new TypeError(`Theme token ${group}.${name} is not a valid value`)
}

export function defineTheme<T extends ThemeTokens>(tokens: T): Theme<T> {
  const frozen = {} as Record<keyof ThemeTokens, Readonly<Record<string, number>>>
  for (const group of ['colors', 'space', 'radii', 'fontSizes'] as const) {
    const values = tokens[group]
    if (!values || typeof values !== 'object')
      throw new TypeError('Theme tokens require a ' + group + ' group')
    for (const [name, value] of Object.entries(values)) check(group, name, value)
    frozen[group] = Object.freeze({ ...values })
  }
  const copy = Object.freeze(frozen) as unknown as T
  return Object.freeze({
    tokens: copy,
    style<const S extends ThemedStyle<T>>(style: S): ResolvedStyle<S> {
      const resolved: Record<string, unknown> = { ...style }
      for (const [field, group] of Object.entries(groups)) {
        const value = resolved[field]
        if (typeof value !== 'string') continue
        const table: Readonly<Record<string, number>> = copy[group]
        if (!Object.hasOwn(table, value))
          throw new TypeError(`Unknown ${group} token for ${field}: ${value}`)
        resolved[field] = table[value]
      }
      return resolved as ResolvedStyle<S>
    },
  })
}

/** The values the native host uses when a primitive's style omits a field. */
export const defaultTheme = defineTheme({
  colors: {
    surface: 0xffffff,
    text: 0x17212b,
    accent: 0x2255cc,
    on_accent: 0xffffff,
    disabled: 0x7a8396,
    divider: 0xc8ced8,
  },
  space: { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radii: { none: 0, sm: 4, md: 8, lg: 12 },
  fontSizes: { sm: 14, body: 18, lg: 24, xl: 32 },
})

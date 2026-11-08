import { defineTheme } from '@bun-native/core'

/**
 * Adea design tokens on native GPUI styles (#233).
 *
 * The OKLCH values below are copied verbatim from `@adea-ai/ui`
 * `packages/ui/src/styles/theme.css` at adea-ai/ui 79dda121 (`:root` for
 * light, `.dark` for dark). CSS custom properties, `color-mix()` and alpha do
 * not exist natively, so each value is converted to 24-bit sRGB here, and the
 * two alpha tints Adea derives with `color-mix(in oklch, ...)` are composited
 * over the theme background once (see `tint`).
 */
const ADEA_OKLCH = {
  light: {
    background: 'oklch(1 0 0)',
    foreground: 'oklch(0.2542 0.0111 254.04)',
    card: 'oklch(0.965 0 0)',
    popover: 'oklch(0.935 0 0)',
    popoverForeground: 'oklch(0.2542 0.0111 254.04)',
    surfaceHover: 'oklch(0.9 0 0)',
    primary: 'oklch(0.5143 0.1668 301.69)',
    primaryForeground: 'oklch(1 0 0)',
    primaryHover: 'oklch(0.4643 0.1668 301.69)',
    secondary: 'oklch(0.965 0 0)',
    secondaryForeground: 'oklch(0.2542 0.0111 254.04)',
    mutedForeground: 'oklch(0.4929 0.0076 254.04)',
    destructiveAction: 'oklch(0.5165 0.1626 25.78)',
    destructiveActionForeground: 'oklch(1 0 0)',
    success: 'oklch(0.4771 0.1809 145.62)',
    successForeground: 'oklch(1 0 0)',
    border: 'oklch(0.85 0 0)',
    input: 'oklch(0.85 0 0)',
  },
  dark: {
    background: 'oklch(0.1756 0.0063 300.91)',
    foreground: 'oklch(0.942 0.0054 297.72)',
    card: 'oklch(0.2106 0.0076 300.91)',
    popover: 'oklch(0.2406 0.0088 300.91)',
    popoverForeground: 'oklch(0.942 0.0054 297.72)',
    surfaceHover: 'oklch(0.2756 0.0101 300.91)',
    primary: 'oklch(0.7323 0.1668 301.69)',
    primaryForeground: 'oklch(0.1756 0.0063 300.91)',
    primaryHover: 'oklch(0.7823 0.1668 301.69)',
    secondary: 'oklch(0.2106 0.0076 300.91)',
    secondaryForeground: 'oklch(0.942 0.0054 297.72)',
    mutedForeground: 'oklch(0.6967 0.0057 298.74)',
    destructiveAction: 'oklch(0.7345 0.1626 25.78)',
    destructiveActionForeground: 'oklch(0.1756 0.0063 300.91)',
    success: 'oklch(0.6951 0.1809 145.62)',
    successForeground: 'oklch(0.1756 0.0063 300.91)',
    border: 'oklch(0.3256 0.0057 300.91)',
    input: 'oklch(0.3256 0.0057 300.91)',
  },
} as const

/** Adea's `--primary-subtle` alpha: 10% light, 16% dark. */
const PRIMARY_SUBTLE = { light: 0.1, dark: 0.16 } as const

/** OKLCH (CSS Color 4) to a gamut-clipped 24-bit sRGB integer. */
export function oklchToRgb(value: string): number {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value)
  if (!match) throw new Error(`Unsupported color ${value}`)
  const [l, c, h] = [Number(match[1]), Number(match[2]), (Number(match[3]) * Math.PI) / 180]
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  return linear
    .map((channel) => {
      const clipped = Math.min(1, Math.max(0, channel))
      const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055
      return Math.round(encoded * 255)
    })
    .reduce((rgb, channel) => (rgb << 8) | channel, 0)
}

/** `color` at `alpha` over `background`, in sRGB. */
export function tint(color: number, alpha: number, background: number): number {
  let out = 0
  for (const shift of [16, 8, 0]) {
    const top = (color >> shift) & 0xff
    const bottom = (background >> shift) & 0xff
    out |= Math.round(top * alpha + bottom * (1 - alpha)) << shift
  }
  return out
}

export type Scheme = keyof typeof ADEA_OKLCH
type ColorName = keyof (typeof ADEA_OKLCH)['light'] | 'primarySubtle'

function colors(scheme: Scheme): Record<ColorName, number> {
  const out = Object.fromEntries(
    Object.entries(ADEA_OKLCH[scheme]).map(([name, value]) => [name, oklchToRgb(value)])
  ) as Record<ColorName, number>
  out.primarySubtle = tint(out.primary, PRIMARY_SUBTLE[scheme], out.background)
  return out
}

/**
 * Adea's control ladder (`--control-height-*`, `--control-padding-*`, and the
 * `text-*` size each control size uses), comfortable density, in logical
 * pixels: `theme.css` 548-582 at the same revision.
 */
export const CONTROL_SIZES = {
  '2xs': { height: 20, padding: 6, fontSize: 11 },
  xs: { height: 24, padding: 8, fontSize: 12 },
  sm: { height: 28, padding: 10, fontSize: 12 },
  md: { height: 32, padding: 12, fontSize: 14 },
  lg: { height: 36, padding: 14, fontSize: 14 },
  xl: { height: 40, padding: 16, fontSize: 16 },
  '2xl': { height: 48, padding: 18, fontSize: 18 },
} as const
export type ControlSize = keyof typeof CONTROL_SIZES

/** One native theme per Adea color scheme. `--radius-md` is 8px. */
export function adeaTheme(scheme: Scheme) {
  return defineTheme({
    colors: colors(scheme),
    space: { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    radii: { sm: 4, md: 8, lg: 12 },
    fontSizes: { xs: 12, sm: 14, base: 16, lg: 18, title: 18 },
  })
}
export type AdeaTheme = ReturnType<typeof adeaTheme>

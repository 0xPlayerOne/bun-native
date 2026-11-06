import { describe, expect, test } from 'bun:test'
import { defaultTheme, defineTheme } from '@bun-native/core'
import { parseElement } from '@bun-native/protocol'

const empty = { colors: {}, space: {}, radii: {}, fontSizes: {} }

describe('theme token validation', () => {
  test('boundary values are accepted and every invalid value names its token', () => {
    const theme = defineTheme({
      colors: { black: 0, white: 0xff_ffff },
      space: { none: 0, wide: 1.5 },
      radii: { none: 0 },
      fontSizes: { tiny: 0.5 },
    })
    expect(theme.tokens.colors).toEqual({ black: 0, white: 0xff_ffff })
    expect(theme.tokens.space.wide).toBe(1.5)
    for (const [group, value] of [
      ['colors', -1],
      ['colors', Number.POSITIVE_INFINITY],
      ['space', Number.POSITIVE_INFINITY],
      ['radii', -0.5],
      ['fontSizes', '18'],
      ['fontSizes', null],
    ] as const)
      expect(() => defineTheme({ ...empty, [group]: { bad: value } } as never)).toThrow(
        `Theme token ${group}.bad is not a valid value`
      )
  })

  test('every group is required and must be an object', () => {
    for (const group of ['colors', 'space', 'radii', 'fontSizes'] as const) {
      for (const value of [undefined, null, 4, 'colors'])
        expect(() => defineTheme({ ...empty, [group]: value } as never)).toThrow(
          `Theme tokens require a ${group} group`
        )
    }
  })

  test('tokens are copied and frozen; later changes to the input have no effect', () => {
    const colors: Record<string, number> = { surface: 0x101010 }
    const theme = defineTheme({ ...empty, colors, extra: { a: 1 } } as typeof empty)
    colors['surface'] = 0x202020
    colors['added'] = 0x303030
    expect(theme.tokens.colors).toEqual({ surface: 0x101010 })
    // Only the four token groups are kept.
    expect(Object.keys(theme.tokens).sort()).toEqual(['colors', 'fontSizes', 'radii', 'space'])
    expect(Object.isFrozen(theme)).toBe(true)
    expect(() => {
      ;(theme.tokens.colors as Record<string, number>)['surface'] = 1
    }).toThrow(TypeError)
  })
})

describe('theme style resolution', () => {
  const theme = defineTheme({
    colors: { surface: 0x223344, text: 0xeeeeee },
    space: { md: 12 },
    radii: { md: 6 },
    fontSizes: { body: 16 },
  })

  test('only own token names resolve; inherited object keys are unknown', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty'])
      expect(() => theme.style({ background: name as 'surface' })).toThrow(
        `Unknown colors token for background: ${name}`
      )
    expect(() => theme.style({ font_size: 'md' as 'body' })).toThrow(
      'Unknown fontSizes token for font_size: md'
    )
    expect(() => theme.style({ corner_radius: 'body' as 'md' })).toThrow(
      'Unknown radii token for corner_radius: body'
    )
    expect(() => theme.style({ border_color: '' as 'text' })).toThrow('Unknown colors token')
  })

  test('string values of non-token fields pass through unchanged', () => {
    expect(
      theme.style({
        width: 'fill',
        height: 'fill',
        overflow: 'scroll_y',
        direction: 'row',
        justify_content: 'end',
        gap: 'md',
      })
    ).toEqual({
      width: 'fill',
      height: 'fill',
      overflow: 'scroll_y',
      direction: 'row',
      justify_content: 'end',
      gap: 12,
    })
  })

  test('resolution returns a new object and never mutates the input', () => {
    const input = Object.freeze({ background: 'surface', color: 'text', padding: 'md' } as const)
    const resolved = theme.style(input)
    expect(resolved).toEqual({ background: 0x223344, color: 0xeeeeee, padding: 12 })
    expect(resolved).not.toBe(input)
    expect(input.background).toBe('surface')
    expect(theme.style({})).toEqual({})
  })

  test('a resolved style is a valid native element style', () => {
    expect(
      parseElement({
        kind: 'box',
        style: theme.style({ background: 'surface', gap: 'md', padding: 'md' }),
      })
    ).toEqual({ kind: 'box', style: { background: 0x223344, gap: 12, padding: 12 } })
  })

  test('the default theme resolves every token it names', () => {
    const tokens: Record<string, Readonly<Record<string, number>>> = defaultTheme.tokens
    for (const [field, group] of [
      ['color', 'colors'],
      ['gap', 'space'],
      ['corner_radius', 'radii'],
      ['font_size', 'fontSizes'],
    ] as const)
      for (const [name, value] of Object.entries(tokens[group]!))
        expect(
          (defaultTheme.style({ [field]: name } as never) as Record<string, number>)[field]
        ).toBe(value)
    expect(Object.keys(defaultTheme.tokens.colors).sort()).toEqual(
      ['accent', 'disabled', 'divider', 'on_accent', 'surface', 'text'].sort()
    )
  })
})

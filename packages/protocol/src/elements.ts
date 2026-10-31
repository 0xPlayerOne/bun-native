import { ProtocolError } from './framing.ts'
import { integer, keys, number, object, string } from './values.ts'

export interface Style {
  direction?: 'row' | 'column'
  gap?: number
  padding?: number
  width?: number | 'fill'
  height?: number | 'fill'
  min_width?: number
  max_width?: number
  min_height?: number
  max_height?: number
  flex_grow?: number
  flex_shrink?: number
  align_items?: 'start' | 'center' | 'end' | 'stretch'
  justify_content?: 'start' | 'center' | 'end' | 'space_between' | 'space_around' | 'space_evenly'
  overflow?: 'visible' | 'hidden' | 'scroll_x' | 'scroll_y' | 'scroll'
  background?: number
  color?: number
  font_size?: number
}

type LeafStyle = Omit<Style, 'overflow'> & { overflow?: 'visible' | 'hidden' }

export type Element =
  | { kind: 'box'; style?: Style }
  | { kind: 'text'; text: string; style?: LeafStyle }
  | { kind: 'button'; text: string; disabled?: boolean; style?: LeafStyle }
  | { kind: 'input'; value: string; placeholder?: string; style?: LeafStyle }

function choice<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  for (const candidate of values) if (candidate === value) return candidate
  throw new ProtocolError(name + ' must be one of ' + values.join(', '))
}

function requireLeafStyle(style: Style): asserts style is LeafStyle {
  if (style.overflow !== undefined && style.overflow !== 'visible' && style.overflow !== 'hidden')
    throw new ProtocolError('Scrolling is supported only on box elements')
}

function parseStyle(value: unknown): Style {
  const data = object(value)
  keys(data, [
    'direction',
    'gap',
    'padding',
    'width',
    'height',
    'min_width',
    'max_width',
    'min_height',
    'max_height',
    'flex_grow',
    'flex_shrink',
    'align_items',
    'justify_content',
    'overflow',
    'background',
    'color',
    'font_size',
  ])
  const style: Style = {}
  for (const key of ['gap', 'padding'] as const)
    if (key in data) style[key] = number(data[key], key, 0, 4_096)
  for (const key of ['width', 'height'] as const)
    if (key in data) style[key] = data[key] === 'fill' ? 'fill' : number(data[key], key, 0, 16_384)
  for (const key of ['min_width', 'max_width', 'min_height', 'max_height'] as const)
    if (key in data) style[key] = number(data[key], key, 0, 16_384)
  for (const [minimum, maximum] of [
    [style.min_width, style.max_width],
    [style.min_height, style.max_height],
  ])
    if (minimum !== undefined && maximum !== undefined && minimum > maximum)
      throw new ProtocolError('Minimum size must not exceed maximum size')
  for (const key of ['background', 'color'] as const)
    if (key in data) style[key] = integer(data[key], key, 0, 0xff_ffff)
  if ('direction' in data)
    style.direction = choice(data['direction'], 'direction', ['row', 'column'])
  for (const key of ['flex_grow', 'flex_shrink'] as const)
    if (key in data) style[key] = number(data[key], key, 0, 1_000)
  if ('align_items' in data)
    style.align_items = choice(data['align_items'], 'align_items', [
      'start',
      'center',
      'end',
      'stretch',
    ])
  if ('justify_content' in data)
    style.justify_content = choice(data['justify_content'], 'justify_content', [
      'start',
      'center',
      'end',
      'space_between',
      'space_around',
      'space_evenly',
    ])
  if ('overflow' in data)
    style.overflow = choice(data['overflow'], 'overflow', [
      'visible',
      'hidden',
      'scroll_x',
      'scroll_y',
      'scroll',
    ])
  if ('font_size' in data) style.font_size = number(data['font_size'], 'font_size', 1, 512)
  return style
}

/** Normalize and validate the entire property set, including JavaScript consumers. */
export function parseElement(value: unknown): Element {
  const element = object(value)
  const style = 'style' in element ? parseStyle(element['style']) : {}
  switch (element['kind']) {
    case 'box':
      keys(element, ['kind', 'style'])
      return { kind: 'box', style }
    case 'text':
      keys(element, ['kind', 'text', 'style'])
      requireLeafStyle(style)
      return { kind: 'text', text: string(element['text'], 'text'), style }
    case 'button': {
      keys(element, ['kind', 'text', 'disabled', 'style'])
      requireLeafStyle(style)
      if ('disabled' in element && typeof element['disabled'] !== 'boolean')
        throw new ProtocolError('disabled must be a boolean')
      return {
        kind: 'button',
        text: string(element['text'], 'text'),
        disabled: element['disabled'] === true,
        style,
      }
    }
    case 'input':
      keys(element, ['kind', 'value', 'placeholder', 'style'])
      requireLeafStyle(style)
      return {
        kind: 'input',
        value: string(element['value'], 'value'),
        placeholder: 'placeholder' in element ? string(element['placeholder'], 'placeholder') : '',
        style,
      }
    default:
      throw new ProtocolError('Unknown native element kind')
  }
}

import { ProtocolError } from './framing.ts'
import { fields, integer, keys, number, object, string } from './values.ts'

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
  /** Requires `scroll_y` or `scroll`. `end` keeps a viewport already at its end pinned there. */
  scroll_anchor?: 'start' | 'end'
  background?: number
  color?: number
  font_size?: number
  /** `style_decoration_v1`: one uniform border width, 0–64 logical pixels. */
  border_width?: number
  /** `style_decoration_v1`: unsigned 24-bit RGB. */
  border_color?: number
  /** `style_decoration_v1`: one radius for every corner, 0–4,096 logical pixels. */
  corner_radius?: number
  /** `style_decoration_v1`: 0–1, multiplying descendants too. */
  opacity?: number
  /** `style_decoration_v1`: inherited 100–900 in steps of 100. */
  font_weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
}

type LeafStyle = Omit<Style, 'overflow' | 'scroll_anchor'> & { overflow?: 'visible' | 'hidden' }
/** A split's `direction` selects its axis; gap, alignment and scrolling do not apply. */
export type SplitStyle = Omit<LeafStyle, 'gap' | 'align_items' | 'justify_content'>

/** Main-axis thickness of the host-drawn split divider, in logical pixels. */
export const SPLIT_DIVIDER = 6

/** Style fields that require `style_decoration_v1`. */
export const DECORATION_FIELDS = Object.freeze([
  'border_width',
  'border_color',
  'corner_radius',
  'opacity',
  'font_weight',
] as const)

/** Overlays nested inside overlays, the outermost counting as one. */
export const MAX_OVERLAY_DEPTH = 8

/** Requires the `overlay_keyboard_v1` capability; defaults are omitted when normalized. */
export interface OverlayKeyboard {
  /** Focus the layer's first enabled control when it opens. */
  autofocus?: boolean
  /** `menu`: Up/Down/Home/End rove focus among the layer's controls and printable keys type ahead. */
  navigation?: 'tab' | 'menu'
}

/**
 * `window` covers the viewport and blocks pointer input beneath it; `parent`
 * is content-sized below its parent's bottom-left corner. Only window
 * overlays may be modal. `surface: 'window'` (capability `popup_windows_v1`)
 * paints a parent-anchored overlay into an owned popup window that may extend
 * beyond its parent window; it needs a fixed pixel `width` and `height`.
 */
export type OverlayElement = (
  | ({
      kind: 'overlay'
      anchor?: 'window'
      modal?: boolean
      surface?: 'layer'
      style?: Style
    } & OverlayKeyboard)
  | ({
      kind: 'overlay'
      anchor: 'parent'
      modal?: false
      surface?: 'layer'
      style?: Style
    } & OverlayKeyboard)
  | {
      kind: 'overlay'
      anchor: 'parent'
      modal?: false
      surface: 'window'
      /** A popup window never takes keyboard focus from its parent window. */
      autofocus?: false
      navigation?: 'tab'
      style: Style & { width: number; height: number }
    }
) &
  AccessibleLabel

/**
 * Requires `accessibility_v1`: the accessible name of an overlay's dialog or
 * a split's divider. It is never painted and counts toward the text budgets.
 */
export interface AccessibleLabel {
  accessible_label?: string
}

/** The largest `accessible_set_size` and `accessible_position`. */
export const MAX_ACCESSIBLE_SET_SIZE = 2_147_483_647

/**
 * Requires `accessibility_lists_v1`. A box without `accessible_role` is layout
 * only and has no accessible node. A list's `accessible_set_size` counts every
 * item, mounted or not; an item's `accessible_position` is its 1-based place
 * in that full set, so assistive technology knows a windowed list's extent.
 */
export interface BoxAccessibility {
  accessible_role?: 'list' | 'list_item'
  /** Only with a role: the list's or item's accessible name. */
  accessible_label?: string
  /** Only on a `list`. */
  accessible_set_size?: number
  /** Only on a `list_item`; 1-based. */
  accessible_position?: number
  /** Only on a `list_item`. Present: the item is selectable; true when selected. */
  accessible_selected?: boolean
}

export type Element =
  | ({ kind: 'box'; style?: Style } & BoxAccessibility)
  | {
      kind: 'text'
      text: string
      /**
       * Requires `accessibility_lists_v1`: announce the text when the node
       * appears and whenever it changes.
       */
      accessible_live?: 'polite' | 'assertive'
      style?: LeafStyle
    }
  | { kind: 'button'; text: string; disabled?: boolean; style?: LeafStyle }
  | {
      kind: 'input'
      value: string
      placeholder?: string
      /** Requires `input_states_v1`. Not focusable, editable or selectable. */
      disabled?: boolean
      /** Requires `input_states_v1`. Focusable and copyable; native edits are rejected. */
      read_only?: boolean
      style?: LeafStyle
    }
  /**
   * `split_v1`: at most two panes and a host-owned draggable divider. `ratio`
   * (default 0.5) is the leading pane's share after the divider; the host
   * keeps a user's drag until a different ratio is declared.
   */
  | ({ kind: 'split'; ratio?: number; min_size?: number; style?: SplitStyle } & AccessibleLabel)
  | OverlayElement

function choice<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  for (const candidate of values) if (candidate === value) return candidate
  throw new ProtocolError(name + ' must be one of ' + values.join(', '))
}

function requireLeafStyle(style: Style): asserts style is LeafStyle {
  if (style.overflow !== undefined && style.overflow !== 'visible' && style.overflow !== 'hidden')
    throw new ProtocolError('Scrolling is supported only on box and overlay elements')
}

const STYLE_KEYS = fields(
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
  'scroll_anchor',
  'background',
  'color',
  'font_size',
  ...DECORATION_FIELDS
)

function parseStyle(value: unknown): Style {
  const data = object(value)
  keys(data, STYLE_KEYS)
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
  for (const key of ['background', 'color', 'border_color'] as const)
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
  if ('scroll_anchor' in data) {
    style.scroll_anchor = choice(data['scroll_anchor'], 'scroll_anchor', ['start', 'end'])
    if (style.overflow !== 'scroll_y' && style.overflow !== 'scroll')
      throw new ProtocolError('scroll_anchor requires vertical scrolling overflow')
  }
  if ('font_size' in data) style.font_size = number(data['font_size'], 'font_size', 1, 512)
  if ('border_width' in data)
    style.border_width = number(data['border_width'], 'border_width', 0, 64)
  if ('corner_radius' in data)
    style.corner_radius = number(data['corner_radius'], 'corner_radius', 0, 4_096)
  if ('opacity' in data) style.opacity = number(data['opacity'], 'opacity', 0, 1)
  if ('font_weight' in data) {
    const weight = integer(data['font_weight'], 'font_weight', 100, 900)
    if (weight % 100 !== 0) throw new ProtocolError('font_weight must be a multiple of 100')
    style.font_weight = weight as NonNullable<Style['font_weight']>
  }
  return style
}

function accessibleLabel(element: Record<string, unknown>): AccessibleLabel {
  return 'accessible_label' in element
    ? { accessible_label: string(element['accessible_label'], 'accessible_label') }
    : {}
}

function boxAccessibility(element: Record<string, unknown>): BoxAccessibility {
  const label = accessibleLabel(element)
  if (!('accessible_role' in element)) {
    for (const name of [
      'accessible_label',
      'accessible_set_size',
      'accessible_position',
      'accessible_selected',
    ])
      if (name in element) throw new ProtocolError(name + ' requires accessible_role')
    return {}
  }
  const role = choice(element['accessible_role'], 'accessible_role', ['list', 'list_item'])
  if (role === 'list') {
    for (const name of ['accessible_position', 'accessible_selected'])
      if (name in element) throw new ProtocolError(name + ' is only accepted on a list_item')
    return {
      accessible_role: role,
      ...label,
      ...('accessible_set_size' in element
        ? {
            accessible_set_size: integer(
              element['accessible_set_size'],
              'accessible_set_size',
              0,
              MAX_ACCESSIBLE_SET_SIZE
            ),
          }
        : {}),
    }
  }
  if ('accessible_set_size' in element)
    throw new ProtocolError('accessible_set_size is only accepted on a list')
  if ('accessible_selected' in element && typeof element['accessible_selected'] !== 'boolean')
    throw new ProtocolError('accessible_selected must be a boolean')
  return {
    accessible_role: role,
    ...label,
    ...('accessible_position' in element
      ? {
          accessible_position: integer(
            element['accessible_position'],
            'accessible_position',
            1,
            MAX_ACCESSIBLE_SET_SIZE
          ),
        }
      : {}),
    ...('accessible_selected' in element
      ? { accessible_selected: element['accessible_selected'] as boolean }
      : {}),
  }
}

const ELEMENT_BOX_KEYS = fields(
  'kind',
  'accessible_role',
  'accessible_label',
  'accessible_set_size',
  'accessible_position',
  'accessible_selected',
  'style'
)
const ELEMENT_TEXT_KEYS = fields('kind', 'text', 'accessible_live', 'style')
const ELEMENT_BUTTON_KEYS = fields('kind', 'text', 'disabled', 'style')
const ELEMENT_INPUT_KEYS = fields('kind', 'value', 'placeholder', 'disabled', 'read_only', 'style')
const ELEMENT_SPLIT_KEYS = fields('kind', 'ratio', 'min_size', 'accessible_label', 'style')
const ELEMENT_OVERLAY_KEYS = fields(
  'kind',
  'anchor',
  'modal',
  'surface',
  'autofocus',
  'navigation',
  'accessible_label',
  'style'
)

/**
 * Elements this module produced. Each is frozen with its style, so it is still
 * exactly the normalized value that passed validation.
 */
const parsed = new WeakSet<Element>()

/**
 * Normalize and validate the entire property set, including JavaScript consumers.
 *
 * The result is frozen and returned unchanged when parsed again, so core's
 * normalized elements cross the runtime boundary in O(1). Any other value,
 * including an unfrozen copy of a parsed element, is validated in full.
 */
export function parseElement(value: unknown): Element {
  if (parsed.has(value as Element)) return value as Element
  const element = validElement(value)
  Object.freeze(element.style)
  parsed.add(Object.freeze(element))
  return element
}

function validElement(value: unknown): Element {
  const element = object(value)
  const style = 'style' in element ? parseStyle(element['style']) : {}
  switch (element['kind']) {
    case 'box':
      keys(element, ELEMENT_BOX_KEYS)
      return { kind: 'box', ...boxAccessibility(element), style }
    case 'text':
      keys(element, ELEMENT_TEXT_KEYS)
      requireLeafStyle(style)
      return {
        kind: 'text',
        text: string(element['text'], 'text'),
        ...('accessible_live' in element
          ? {
              accessible_live: choice(element['accessible_live'], 'accessible_live', [
                'polite',
                'assertive',
              ]),
            }
          : {}),
        style,
      }
    case 'button': {
      keys(element, ELEMENT_BUTTON_KEYS)
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
    case 'input': {
      keys(element, ELEMENT_INPUT_KEYS)
      requireLeafStyle(style)
      for (const name of ['disabled', 'read_only'])
        if (name in element && typeof element[name] !== 'boolean')
          throw new ProtocolError(name + ' must be a boolean')
      // Only true states are carried, so ordinary inputs keep their exact wire form.
      return {
        kind: 'input',
        value: string(element['value'], 'value'),
        placeholder: 'placeholder' in element ? string(element['placeholder'], 'placeholder') : '',
        ...(element['disabled'] === true ? { disabled: true } : {}),
        ...(element['read_only'] === true ? { read_only: true } : {}),
        style,
      }
    }
    case 'split': {
      keys(element, ELEMENT_SPLIT_KEYS)
      requireLeafStyle(style)
      if (
        style.gap !== undefined ||
        style.align_items !== undefined ||
        style.justify_content !== undefined
      )
        throw new ProtocolError('Split panes do not accept gap or alignment')
      return {
        kind: 'split',
        ratio: 'ratio' in element ? number(element['ratio'], 'ratio', 0, 1) : 0.5,
        min_size: 'min_size' in element ? number(element['min_size'], 'min_size', 0, 16_384) : 0,
        ...accessibleLabel(element),
        style,
      }
    }
    case 'overlay': {
      keys(element, ELEMENT_OVERLAY_KEYS)
      const label = accessibleLabel(element)
      const anchor =
        'anchor' in element ? choice(element['anchor'], 'anchor', ['window', 'parent']) : 'window'
      for (const flag of ['modal', 'autofocus'])
        if (flag in element && typeof element[flag] !== 'boolean')
          throw new ProtocolError(flag + ' must be a boolean')
      const modal = element['modal'] === true
      const keyboard: OverlayKeyboard = {
        ...(element['autofocus'] === true ? { autofocus: true } : {}),
        ...('navigation' in element &&
        choice(element['navigation'], 'navigation', ['tab', 'menu']) === 'menu'
          ? { navigation: 'menu' as const }
          : {}),
      }
      const surface =
        'surface' in element ? choice(element['surface'], 'surface', ['layer', 'window']) : 'layer'
      if (surface === 'window') {
        if (anchor !== 'parent')
          throw new ProtocolError('A popup window overlay must be anchored to its parent')
        if (modal) throw new ProtocolError('A modal overlay must be anchored to the window')
        if (keyboard.autofocus || keyboard.navigation)
          throw new ProtocolError('A popup window overlay does not take keyboard focus')
        const { width, height } = style
        if (typeof width !== 'number' || width < 1 || typeof height !== 'number' || height < 1)
          throw new ProtocolError('A popup window overlay needs a fixed width and height')
        return {
          kind: 'overlay',
          anchor,
          modal: false,
          surface,
          ...label,
          style: { ...style, width, height },
        }
      }
      if (anchor === 'parent') {
        if (modal) throw new ProtocolError('A modal overlay must be anchored to the window')
        return { kind: 'overlay', anchor, modal: false, ...keyboard, ...label, style }
      }
      return { kind: 'overlay', anchor, modal, ...keyboard, ...label, style }
    }
    default:
      throw new ProtocolError('Unknown native element kind')
  }
}

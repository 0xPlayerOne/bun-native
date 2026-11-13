import { ProtocolError } from './framing.ts'
import { choice, integer, keys, number, object, string } from './values.ts'
import {
  ACCESSIBLE_ROLES,
  ELEMENT_KEYS,
  LIVE_POLITENESS,
  MAX_ACCESSIBLE_SET_SIZE,
  OVERLAY_ANCHORS,
  OVERLAY_NAVIGATIONS,
  OVERLAY_SURFACES,
  STYLE_FIELDS,
  type AccessibleRole,
  type Live,
  type Style,
} from './wire-schema.ts'

export type { Style }

type LeafStyle = Omit<Style, 'overflow' | 'scroll_anchor'> & { overflow?: 'visible' | 'hidden' }
/** A split's `direction` selects its axis; gap, alignment and scrolling do not apply. */
export type SplitStyle = Omit<LeafStyle, 'gap' | 'align_items' | 'justify_content'>

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

/**
 * Requires `accessibility_lists_v1`. A box without `accessible_role` is layout
 * only and has no accessible node. A list's `accessible_set_size` counts every
 * item, mounted or not; an item's `accessible_position` is its 1-based place
 * in that full set, so assistive technology knows a windowed list's extent.
 */
export interface BoxAccessibility {
  accessible_role?: AccessibleRole
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
      accessible_live?: Live
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

function requireLeafStyle(style: Style): asserts style is LeafStyle {
  if (style.overflow !== undefined && style.overflow !== 'visible' && style.overflow !== 'hidden')
    throw new ProtocolError('Scrolling is supported only on box and overlay elements')
}

/**
 * One pass over the members present, each checked by its generated field
 * description. Inherited properties are ignored, as `keys` ignores them.
 */
function parseStyle(value: unknown): Style {
  const data = object(value)
  const style: Record<string, unknown> = {}
  for (const key of Object.keys(data)) {
    const field = STYLE_FIELDS.get(key)
    if (field === undefined) throw new ProtocolError('Unknown message property: ' + key)
    const member = data[key]
    switch (field.type) {
      case 'number':
        style[key] = number(member, key, field.min, field.max)
        break
      case 'dimension':
        style[key] = member === 'fill' ? 'fill' : number(member, key, field.min, field.max)
        break
      case 'color':
        style[key] = integer(member, key, 0, 0xff_ffff)
        break
      case 'enum':
        style[key] = choice(member, key, field.values)
        break
      case 'weight':
        style[key] = integer(member, key, field.min, field.max)
        if ((style[key] as number) % field.step !== 0)
          throw new ProtocolError(key + ' must be a multiple of ' + field.step)
    }
  }
  const parsed = style as Style
  for (const [minimum, maximum] of [
    [parsed.min_width, parsed.max_width],
    [parsed.min_height, parsed.max_height],
  ])
    if (minimum !== undefined && maximum !== undefined && minimum > maximum)
      throw new ProtocolError('Minimum size must not exceed maximum size')
  if (
    parsed.scroll_anchor !== undefined &&
    parsed.overflow !== 'scroll_y' &&
    parsed.overflow !== 'scroll'
  )
    throw new ProtocolError('scroll_anchor requires vertical scrolling overflow')
  return parsed
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
  const role = choice(element['accessible_role'], 'accessible_role', ACCESSIBLE_ROLES)
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
      keys(element, ELEMENT_KEYS.box)
      return { kind: 'box', ...boxAccessibility(element), style }
    case 'text':
      keys(element, ELEMENT_KEYS.text)
      requireLeafStyle(style)
      return {
        kind: 'text',
        text: string(element['text'], 'text'),
        ...('accessible_live' in element
          ? {
              accessible_live: choice(
                element['accessible_live'],
                'accessible_live',
                LIVE_POLITENESS
              ),
            }
          : {}),
        style,
      }
    case 'button': {
      keys(element, ELEMENT_KEYS.button)
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
      keys(element, ELEMENT_KEYS.input)
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
      keys(element, ELEMENT_KEYS.split)
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
      keys(element, ELEMENT_KEYS.overlay)
      const label = accessibleLabel(element)
      const anchor =
        'anchor' in element ? choice(element['anchor'], 'anchor', OVERLAY_ANCHORS) : 'window'
      for (const flag of ['modal', 'autofocus'])
        if (flag in element && typeof element[flag] !== 'boolean')
          throw new ProtocolError(flag + ' must be a boolean')
      const modal = element['modal'] === true
      const keyboard: OverlayKeyboard = {
        ...(element['autofocus'] === true ? { autofocus: true } : {}),
        ...('navigation' in element &&
        choice(element['navigation'], 'navigation', OVERLAY_NAVIGATIONS) === 'menu'
          ? { navigation: 'menu' as const }
          : {}),
      }
      const surface =
        'surface' in element ? choice(element['surface'], 'surface', OVERLAY_SURFACES) : 'layer'
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

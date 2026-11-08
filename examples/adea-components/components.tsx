import type { InputState, KeyEvent } from '@bun-native/core'
import type { JSX } from '@bun-native/solid'
import { createSignal, For, Show, type Accessor } from 'solid-js'
import { CONTROL_SIZES, type AdeaTheme, type ControlSize } from './tokens.ts'

/*
 * Native ports of four `@adea-ai/ui` primitives (adea-ai/ui 79dda121):
 * Button, Input, DropdownMenu and Dialog. Each keeps Adea's public vocabulary
 * (variant and size names, the dialog's mandatory close control, the toolbar
 * trigger's expanded tint) and replaces Kobalte, Tailwind and DOM with the
 * shared native `button`, `input`, `box`, `text` and `overlay` primitives.
 * The README's port inventory lists what is retained, modified and replaced.
 */

type Colors = AdeaTheme['tokens']['colors']

/**
 * Adea's `buttonVariants` appearance ladder. Each entry answers "what is this
 * for", as in Adea; the colors are the same tokens its Tailwind classes name.
 * `hover:` and `focus-visible:` states have no native style field and are
 * dropped; GPUI draws its own focus ring.
 */
const VARIANTS = {
  /** The one primary action in a view. */
  default: (c: Colors) => ({ background: c.primary, color: c.primaryForeground }),
  secondary: (c: Colors) => ({ background: c.secondary, color: c.secondaryForeground }),
  /** For the action that destroys something. Never the default. */
  destructive: (c: Colors) => ({
    background: c.destructiveAction,
    color: c.destructiveActionForeground,
  }),
  /** A bordered button for a surface that already has a fill. */
  outline: (c: Colors) => ({
    background: c.background,
    color: c.foreground,
    border_width: 1,
    border_color: c.border,
  }),
  /** No chrome until hover. The default for toolbar and row actions. */
  ghost: (c: Colors) => ({ background: c.background, color: c.foreground }),
  /** A ghost that opens something; holds the accent tint while its surface is open. */
  toolbar: (c: Colors, expanded: boolean) =>
    expanded
      ? { background: c.primarySubtle, color: c.primary }
      : { background: c.background, color: c.foreground },
  /** A tinted primary, for a secondary action inside a primary flow. */
  subtle: (c: Colors) => ({ background: c.primarySubtle, color: c.primary }),
  success: (c: Colors) => ({ background: c.success, color: c.successForeground }),
  link: (c: Colors) => ({ background: c.background, color: c.primary }),
} as const
export type ButtonVariant = keyof typeof VARIANTS

export function buttonStyle(
  theme: AdeaTheme,
  variant: ButtonVariant = 'default',
  size: ControlSize = 'md',
  expanded = false
) {
  const control = CONTROL_SIZES[size]
  return {
    ...VARIANTS[variant](theme.tokens.colors, expanded),
    height: control.height,
    padding: control.padding,
    font_size: control.fontSize,
    font_weight: 500,
    corner_radius: theme.tokens.radii.md,
  } as const
}

export function Button(props: {
  theme: Accessor<AdeaTheme>
  text: string
  variant?: ButtonVariant
  size?: ControlSize
  expanded?: boolean
  disabled?: boolean
  onClick?: () => void | Promise<void>
}): JSX.Element {
  return (
    <button
      text={props.text}
      disabled={props.disabled ?? false}
      style={buttonStyle(props.theme(), props.variant, props.size, props.expanded)}
      onClick={() => props.onClick?.()}
    />
  )
}

/**
 * Adea's Input: deliberately a plain input whose height comes from the control
 * ladder, so it aligns with Button. Native text editing, caret and IME belong
 * to GPUI. `suggestions` (an HTML datalist) and the `Field` ARIA wiring have no
 * native counterpart.
 */
export function Input(props: {
  theme: Accessor<AdeaTheme>
  value: InputState
  placeholder: string
  size?: ControlSize
  disabled?: boolean
  onInput: (state: InputState) => void
}): JSX.Element {
  const style = () => {
    const { colors, radii } = props.theme().tokens
    const control = CONTROL_SIZES[props.size ?? 'md']
    return {
      flex_grow: 1,
      height: control.height,
      font_size: control.fontSize,
      background: colors.background,
      color: colors.foreground,
      border_width: 1,
      border_color: colors.input,
      corner_radius: radii.md,
    } as const
  }
  return (
    <input
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled ?? false}
      style={style()}
      onInput={(event) => props.onInput(event)}
    />
  )
}

const isEscape = (event: KeyEvent) => {
  const { control, alt, shift, platform, function: fn } = event.modifiers
  return event.key === 'escape' && !control && !alt && !shift && !platform && !fn
}

export type MenuItem = { label: string; destructive?: boolean; disabled?: boolean }

/**
 * Adea's DropdownMenu: a `toolbar` trigger that holds its expanded tint while
 * open, and a popover of items. Kobalte's menu is replaced by a native
 * parent-anchored overlay with `navigation: 'menu'` (arrow keys, Home/End and
 * type-ahead) and `autofocus`; focus returns to the trigger on close natively.
 * Escape or choosing an item closes it. Submenus, checkbox and radio items,
 * shortcuts and closing on an outside press are not ported.
 */
export function DropdownMenu(props: {
  theme: Accessor<AdeaTheme>
  label: string
  items: readonly MenuItem[]
  onSelect: (label: string) => void | Promise<void>
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  return (
    // A row, so Solid's empty `Show` marker text sits beside the trigger
    // instead of adding a line below it.
    <box style={{ direction: 'row', align_items: 'center' }}>
      <Button
        theme={props.theme}
        text={props.label}
        variant="toolbar"
        size="sm"
        expanded={open()}
        onClick={() => void setOpen((value) => !value)}
      />
      <Show when={open()}>
        <overlay
          anchor="parent"
          autofocus
          navigation="menu"
          accessibleLabel={props.label}
          onKeyDown={(event) => {
            if (!isEscape(event)) return
            event.stopPropagation()
            setOpen(false)
          }}
        >
          <box
            style={{
              direction: 'column',
              gap: 2,
              padding: 4,
              min_width: 160,
              background: props.theme().tokens.colors.popover,
              border_width: 1,
              border_color: props.theme().tokens.colors.border,
              corner_radius: props.theme().tokens.radii.md,
            }}
          >
            <For each={props.items}>
              {(item) => (
                <button
                  text={item.label}
                  disabled={item.disabled ?? false}
                  style={{
                    ...buttonStyle(props.theme(), 'ghost', 'sm'),
                    width: 'fill',
                    background: props.theme().tokens.colors.popover,
                    color: item.destructive
                      ? props.theme().tokens.colors.destructiveAction
                      : props.theme().tokens.colors.popoverForeground,
                  }}
                  onClick={async () => {
                    setOpen(false)
                    await props.onSelect(item.label)
                  }}
                />
              )}
            </For>
          </box>
        </overlay>
      </Show>
    </box>
  )
}

/**
 * Adea's Dialog: a modal surface for a decision or a short task, whose close
 * button is part of the content because a modal whose only exit is Escape is a
 * trap for a pointer user. Kobalte's portal, focus trap, Escape handling and
 * focus return are replaced by a native window overlay (`modal`), which traps
 * Tab, routes unfocused keys and returns focus natively. Escape and a press on
 * the backdrop dismiss it. Scroll locking is unnecessary: a window overlay
 * blocks pointer and wheel input beneath it.
 */
export function Dialog(props: {
  theme: Accessor<AdeaTheme>
  title: string
  description?: string
  onDismiss: () => void
  children?: JSX.Element
  footer?: JSX.Element
}): JSX.Element {
  const colors = () => props.theme().tokens.colors
  return (
    <overlay
      modal
      accessibleLabel={props.title}
      style={{ align_items: 'center', justify_content: 'center', background: colors().background }}
      onKeyDown={(event) => {
        if (!isEscape(event)) return
        event.stopPropagation()
        props.onDismiss()
      }}
      onPointerDown={(event) => {
        // A press on the backdrop targets the overlay itself, not a descendant.
        if (event.phase === 'target') props.onDismiss()
      }}
    >
      <box
        style={{
          direction: 'column',
          gap: 12,
          padding: 24,
          width: 420,
          background: colors().popover,
          border_width: 1,
          border_color: colors().border,
          corner_radius: props.theme().tokens.radii.lg,
        }}
      >
        <box style={{ direction: 'row', justify_content: 'space_between', align_items: 'center' }}>
          <text
            text={props.title}
            style={{ font_size: 18, font_weight: 600, color: colors().popoverForeground }}
          />
          <Button
            theme={props.theme}
            text="Close"
            variant="ghost"
            size="sm"
            onClick={props.onDismiss}
          />
        </box>
        <Show when={props.description}>
          <text
            text={props.description!}
            style={{ font_size: 14, color: colors().mutedForeground }}
          />
        </Show>
        {props.children}
        <Show when={props.footer}>
          <box style={{ direction: 'row', gap: 8, justify_content: 'end' }}>{props.footer}</box>
        </Show>
      </box>
    </overlay>
  )
}

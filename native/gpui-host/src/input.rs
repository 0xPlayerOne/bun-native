// Adapted from Zed GPUI examples/input.rs, revision ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d.
// Copyright the Zed contributors. Licensed under Apache-2.0; see LICENSE-APACHE and NOTICE.
mod binding;
mod hit_test;
mod offsets;
mod paint;
mod selection;
mod viewport;
pub(crate) use binding::InputBinding;
use paint::TextElement;
use selection::Selection;
use std::ops::Range;
use viewport::InputPaint;
pub(crate) use viewport::{InputViewportSnapshot, PaintedInputDecorations};

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, EntityInputHandler, FocusHandle, Focusable,
    KeyBinding, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
    SharedString, UTF16Selection, Window, actions, div, prelude::*, px,
};

actions!(
    text_input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        ShowCharacterPalette,
        Paste,
        Cut,
        Copy,
    ]
);

pub(crate) struct TextInput {
    binding: InputBinding,
    focus_handle: FocusHandle,
    content: SharedString,
    placeholder: SharedString,
    selection: Selection,
    marked_range: Option<Range<usize>>,
    last_paint: Option<InputPaint>,
    is_selecting: bool,
}

impl TextInput {
    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        self.selection.move_left(&self.content);
        self.selection_changed(window, cx);
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        self.selection.move_right(&self.content);
        self.selection_changed(window, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.selection.select_left(&self.content);
        self.selection_changed(window, cx);
    }

    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        self.selection.select_right(&self.content);
        self.selection_changed(window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.selection = Selection::select_all(&self.content);
        self.selection_changed(window, cx);
    }

    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        self.selection = Selection::caret(0);
        self.selection_changed(window, cx);
    }

    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        self.selection = Selection::caret(self.content.len());
        self.selection_changed(window, cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selection.range.is_empty() {
            let cursor = self.selection.cursor();
            let prev = offsets::previous_boundary(&self.content, cursor);
            if cursor == prev {
                window.play_system_bell();
                return;
            }
            self.selection.select_to(prev);
            self.selection_changed(window, cx);
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selection.range.is_empty() {
            let cursor = self.selection.cursor();
            let next = offsets::next_boundary(&self.content, cursor);
            if cursor == next {
                window.play_system_bell();
                return;
            }
            self.selection.select_to(next);
            self.selection_changed(window, cx);
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.is_selecting = true;
        window.focus(&self.focus_handle, cx);
        window.request_virtual_keyboard();

        let index = self.index_for_mouse_position(event.position);
        if event.modifiers.shift {
            self.selection.select_to(index);
        } else {
            self.selection = Selection::caret(index);
        }
        self.selection_changed(window, cx);
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_selecting {
            self.selection
                .select_to(self.index_for_mouse_position(event.position));
            self.selection_changed(window, cx);
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(None, &text.replace("\n", " "), window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selection.range.clone()].to_string(),
            ));
        }
    }
    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selection.range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx)
        }
    }

    fn selection_changed(&self, window: &Window, cx: &mut Context<Self>) {
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify()
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        hit_test::index_for_mouse_position(
            &self.content,
            self.last_paint.as_ref(),
            position,
            self.selection.cursor(),
        )
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        offsets::to_utf16(&self.content, offset)
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        offsets::range_to_utf16(&self.content, range)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        offsets::range_from_utf16(&self.content, range_utf16)
    }

    pub(crate) fn new(
        content: String,
        placeholder: String,
        binding: InputBinding,
        cx: &mut Context<Self>,
    ) -> Self {
        let end = content.len();
        Self {
            binding,
            focus_handle: cx.focus_handle().tab_stop(true),
            content: content.into(),
            placeholder: placeholder.into(),
            selection: Selection::caret(end),
            marked_range: None,
            last_paint: None,
            is_selecting: false,
        }
    }

    pub(crate) fn set_properties(
        &mut self,
        value: &str,
        placeholder: &str,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        if self.placeholder.as_ref() != placeholder {
            self.placeholder = placeholder.to_owned().into();
            cx.notify();
        }
        if self.content.as_ref() == value {
            return;
        }
        let end = value.len();
        self.content = value.to_owned().into();
        self.selection = Selection::caret(end);
        self.marked_range = None;
        self.last_paint = None;
        self.is_selecting = false;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    /// Opt-in diagnostics read the geometry committed by the last actual paint.
    pub(crate) fn painted_viewport(&self) -> Option<InputViewportSnapshot> {
        self.last_paint.as_ref()?.snapshot(&self.content)
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selection.range),
            reversed: self.selection.reversed,
        })
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selection = Selection {
            range: self.range_from_utf16(&range_utf16),
            reversed: false,
        };
        self.selection_changed(window, cx);
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.content.encode_utf16().count())
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selection.range.clone());

        if new_text.contains('\0')
            || self.content.len() - range.len() + new_text.len()
                > bun_native_protocol::MAX_TEXT_BYTES
        {
            window.play_system_bell();
            return;
        }
        let value = self.content[0..range.start].to_owned() + new_text + &self.content[range.end..];
        if !self.binding.edit(&value, cx) {
            window.play_system_bell();
            return;
        }
        self.content = value.into();
        self.selection = Selection::caret(range.start + new_text.len());
        self.marked_range.take();
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selection.range.clone());

        if new_text.contains('\0')
            || self.content.len() - range.len() + new_text.len()
                > bun_native_protocol::MAX_TEXT_BYTES
        {
            window.play_system_bell();
            return;
        }
        let value = self.content[0..range.start].to_owned() + new_text + &self.content[range.end..];
        if !self.binding.edit(&value, cx) {
            window.play_system_bell();
            return;
        }
        self.content = value.into();
        if !new_text.is_empty() {
            self.marked_range = Some(range.start..range.start + new_text.len());
        } else {
            self.marked_range = None;
        }
        let insertion_start_utf16 = self.offset_to_utf16(range.start);
        let inserted_length_utf16 = new_text.encode_utf16().count();
        self.selection = Selection {
            range: new_selected_range_utf16
                .map(|selected| {
                    self.range_from_utf16(
                        &(insertion_start_utf16 + selected.start.min(inserted_length_utf16)
                            ..insertion_start_utf16 + selected.end.min(inserted_length_utf16)),
                    )
                })
                .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len()),
            reversed: false,
        };

        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range_utf16);
        self.last_paint
            .as_ref()?
            .bounds_for_range(&self.content, range)
    }

    fn selection_bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Bounds<Pixels>> {
        self.bounds_for_range(range_utf16, bounds, window, cx)
            .into_iter()
            .collect()
    }

    fn character_index_for_point(
        &mut self,
        point: gpui::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let utf8_index = self
            .last_paint
            .as_ref()?
            .character_index(&self.content, point)?;
        Some(self.offset_to_utf16(utf8_index))
    }
}

impl Render for TextInput {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .w_full()
            .key_context("TextInput")
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::show_character_palette))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(
                div()
                    .min_h(px(32.))
                    .w_full()
                    .p(px(4.))
                    .child(TextElement { input: cx.entity() }),
            )
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("TextInput")),
        KeyBinding::new("delete", Delete, Some("TextInput")),
        KeyBinding::new("left", Left, Some("TextInput")),
        KeyBinding::new("right", Right, Some("TextInput")),
        KeyBinding::new("shift-left", SelectLeft, Some("TextInput")),
        KeyBinding::new("shift-right", SelectRight, Some("TextInput")),
        KeyBinding::new("cmd-a", SelectAll, Some("TextInput")),
        KeyBinding::new("ctrl-a", SelectAll, Some("TextInput")),
        KeyBinding::new("cmd-v", Paste, Some("TextInput")),
        KeyBinding::new("ctrl-v", Paste, Some("TextInput")),
        KeyBinding::new("cmd-c", Copy, Some("TextInput")),
        KeyBinding::new("ctrl-c", Copy, Some("TextInput")),
        KeyBinding::new("cmd-x", Cut, Some("TextInput")),
        KeyBinding::new("ctrl-x", Cut, Some("TextInput")),
        KeyBinding::new("home", Home, Some("TextInput")),
        KeyBinding::new("end", End, Some("TextInput")),
        KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, Some("TextInput")),
    ]);
}

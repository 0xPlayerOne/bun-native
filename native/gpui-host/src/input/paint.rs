// Adapted from Zed GPUI examples/input.rs, revision ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d.
// Copyright the Zed contributors. Licensed under Apache-2.0; see LICENSE-APACHE and NOTICE.
use super::viewport::{CARET_WIDTH, TextViewport};
use super::*;
use gpui::{
    ContentMask, ElementId, ElementInputHandler, Entity, GlobalElementId, LayoutId, PaintQuad,
    ShapedLine, Style, TextRun, UnderlineStyle, fill, point, relative, rgba, size,
};

pub(super) struct TextElement {
    pub(super) input: Entity<TextInput>,
}

pub(super) struct PrepaintState {
    line: Option<ShapedLine>,
    cursor: Option<PaintQuad>,
    selection: Option<PaintQuad>,
    viewport: TextViewport,
    selected_bytes: [usize; 2],
    cursor_byte: usize,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let content = input.content.clone();
        let selected_range = input.selection.range.clone();
        let cursor = input.selection.cursor();
        let style = window.text_style();

        let (display_text, text_color) = if content.is_empty() {
            (input.placeholder.clone(), style.color.opacity(0.6))
        } else {
            (content, style.color)
        };
        let text_color = if input.policy.interactive() {
            text_color
        } else {
            text_color.opacity(0.5)
        };

        let run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = if let Some(marked_range) = input.marked_range.as_ref() {
            vec![
                TextRun {
                    len: marked_range.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked_range.end - marked_range.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display_text.len() - marked_range.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect()
        } else {
            vec![run]
        };

        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = window
            .text_system()
            .shape_line(display_text, font_size, &runs, None);

        let cursor_pos = line.x_for_index(cursor);
        let cursor_byte = cursor;
        let viewport = TextViewport::new(
            bounds,
            line.width(),
            cursor_pos,
            input
                .last_paint
                .as_ref()
                .map_or(px(0.), |paint| paint.viewport.offset),
        );
        let (selection, cursor) = if !input.policy.interactive() {
            (None, None)
        } else if selected_range.is_empty() {
            (
                None,
                Some(fill(
                    Bounds::new(
                        point(viewport.window_x(cursor_pos), bounds.top()),
                        size(CARET_WIDTH, bounds.size.height),
                    ),
                    gpui::blue(),
                )),
            )
        } else {
            (
                Some(fill(
                    viewport.range_bounds(
                        line.x_for_index(selected_range.start),
                        line.x_for_index(selected_range.end),
                    ),
                    rgba(0x3311ff30),
                )),
                None,
            )
        };
        PrepaintState {
            line: Some(line),
            cursor,
            selection,
            viewport,
            selected_bytes: [selected_range.start, selected_range.end],
            cursor_byte,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        let line = prepaint.line.take().unwrap();
        let selection = prepaint.selection.as_ref().map(|quad| quad.bounds);
        let mut caret = None;
        let clip = window.with_content_mask(Some(ContentMask { bounds }), |window| {
            if let Some(selection) = prepaint.selection.take() {
                window.paint_quad(selection)
            }
            line.paint(
                prepaint.viewport.origin(),
                window.line_height(),
                gpui::TextAlign::Left,
                None,
                window,
                cx,
            )
            .unwrap();

            if focus_handle.is_focused(window)
                && let Some(cursor) = prepaint.cursor.take()
            {
                caret = Some(cursor.bounds);
                window.paint_quad(cursor);
            }
            window.content_mask().bounds
        });

        self.input.update(cx, |input, _cx| {
            input.last_paint = Some(InputPaint {
                line,
                viewport: prepaint.viewport,
                decorations: PaintedInputDecorations {
                    clip,
                    caret,
                    selection,
                    selected_bytes: prepaint.selected_bytes,
                    cursor_byte: prepaint.cursor_byte,
                },
            });
        });
    }
}

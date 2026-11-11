use super::*;
use gpui::{FontId, GlyphId, LineLayout, ShapedGlyph, ShapedRun, size};
use std::sync::Arc;

fn bounds(width: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(40.), px(20.)), size(px(width), px(24.)))
}

#[test]
fn long_line_tracks_both_selection_ends_and_preserves_visible_caret_position() {
    let end = TextViewport::new(bounds(100.), px(300.), px(300.), px(0.));
    assert_eq!(end.offset, px(202.));
    assert_eq!(end.window_x(px(300.)) + CARET_WIDTH, end.bounds.right());
    assert_eq!(end.origin(), point(px(-162.), px(20.)));

    // A key movement within the visible viewport must not move the text.
    let left = TextViewport::new(bounds(100.), px(300.), px(240.), end.offset);
    assert_eq!(left.offset, end.offset);
    // Moving the active end of a reversed selection out of view scrolls left.
    let reversed = TextViewport::new(bounds(100.), px(300.), px(130.), left.offset);
    assert_eq!(reversed.offset, px(130.));
    assert_eq!(reversed.window_x(px(130.)), reversed.bounds.left());
    let home = TextViewport::new(bounds(100.), px(300.), px(0.), reversed.offset);
    assert_eq!(home.offset, px(0.));
}

#[test]
fn resize_font_changes_and_content_shrink_reclamp_without_stale_blank_space() {
    let end = TextViewport::new(bounds(100.), px(300.), px(300.), px(0.));
    let narrow = TextViewport::new(bounds(60.), px(300.), px(300.), end.offset);
    assert_eq!(narrow.offset, px(242.));
    let wider = TextViewport::new(bounds(220.), px(300.), px(300.), narrow.offset);
    assert_eq!(wider.offset, px(82.));
    let larger_font = TextViewport::new(bounds(220.), px(450.), px(450.), wider.offset);
    assert_eq!(larger_font.offset, px(232.));
    let short = TextViewport::new(bounds(220.), px(80.), px(80.), larger_font.offset);
    assert_eq!(short.offset, px(0.));
    assert_eq!(short.origin(), short.bounds.origin);
    let empty = TextViewport::new(bounds(220.), px(0.), px(0.), larger_font.offset);
    assert_eq!(empty.offset, px(0.));
}

#[test]
fn zero_and_narrow_viewports_keep_finite_clipped_geometry() {
    for width in [0., 1., 2.] {
        let viewport = TextViewport::new(bounds(width), px(300.), px(300.), px(0.));
        assert_eq!(viewport.offset, px(300.));
        assert_eq!(viewport.window_x(px(300.)), viewport.bounds.left());
        let selection = viewport.range_bounds(px(0.), px(300.));
        assert_eq!(selection.size.width, px(0.));
        assert_eq!(selection.origin, viewport.bounds.origin);
    }
}

// Fixed glyph advances exercise GPUI's actual LineLayout index/range methods.
// This is a geometry control, not a font-shaping or native-pixel qualification.
fn painted_unicode() -> InputPaint {
    let text = "A🌍e\u{301}BC";
    let mut line = ShapedLine::default();
    line.text = text.into();
    *line = Arc::new(LineLayout {
        width: px(100.),
        len: text.len(),
        runs: vec![ShapedRun {
            font_id: FontId(0),
            glyphs: [(0, 0.), (1, 15.), (5, 45.), (8, 65.), (9, 80.)]
                .into_iter()
                .map(|(index, x)| ShapedGlyph {
                    id: GlyphId(0),
                    position: point(px(x), px(0.)),
                    index,
                    is_emoji: index == 1,
                })
                .collect(),
        }],
        ..LineLayout::default()
    });
    InputPaint {
        viewport: TextViewport::new(bounds(50.), line.width(), line.width(), px(0.)),
        line,
        decorations: PaintedInputDecorations {
            clip: bounds(50.),
            caret: Some(Bounds::new(
                point(px(88.), px(20.)),
                size(CARET_WIDTH, px(24.)),
            )),
            selection: None,
            selected_bytes: [10, 10],
            cursor_byte: 10,
        },
        font: gpui::font("Fixed advances"),
        font_size: px(16.),
    }
}

/// A line of `advances.len()` one-byte glyphs with these advances.
fn shaped(text: &str, advances: &[f32]) -> ShapedLine {
    let mut line = ShapedLine::default();
    line.text = text.to_owned().into();
    let mut x = 0.;
    let glyphs = advances
        .iter()
        .enumerate()
        .map(|(index, advance)| {
            let glyph = ShapedGlyph {
                id: GlyphId(0),
                position: point(px(x), px(0.)),
                index,
                is_emoji: false,
            };
            x += advance;
            glyph
        })
        .collect();
    *line = Arc::new(LineLayout {
        width: px(x),
        len: text.len(),
        runs: vec![ShapedRun {
            font_id: FontId(0),
            glyphs,
        }],
        ..LineLayout::default()
    });
    line
}

#[test]
fn text_changed_after_the_paint_is_placed_where_the_next_paint_will_draw_it() {
    // The painted text no longer matches: the paint has no geometry for it.
    let paint = painted_unicode();
    assert_eq!(paint.bounds_for_range("A🌍e\u{301}BCD", 11..11), None);

    // An input method appended a 20-pixel preedit "D" at the end (byte 10):
    // the line is now 120 wide and the next paint scrolls 20 further right to
    // keep the caret (byte 11) visible. The caret rectangle is at the viewport's
    // right edge, not where the previous paint ended.
    let longer = shaped(
        "ABCDEFGHIJK",
        &[15., 30., 20., 15., 20., 0., 0., 0., 0., 0., 20.],
    );
    let caret = paint.projected_bounds_for_range(&longer, 11, 11..11);
    let next = TextViewport::new(
        paint.viewport.bounds,
        px(120.),
        px(120.),
        paint.viewport.offset,
    );
    assert_eq!(next.offset, px(72.));
    assert_eq!(caret.left(), next.window_x(px(120.)));
    assert_eq!(caret.left(), paint.viewport.bounds.right() - CARET_WIDTH);
    // The preedit's own rectangle spans its 20 pixels left of the caret.
    let preedit = paint.projected_bounds_for_range(&longer, 11, 10..11);
    assert_eq!(preedit.size.width, px(20.));
    assert_eq!(preedit.right(), caret.left());
    assert_eq!(preedit.top(), paint.viewport.bounds.top());
    assert_eq!(preedit.bottom(), paint.viewport.bounds.bottom());

    // Text that became shorter scrolls back: an empty field's caret is at the
    // viewport's left edge.
    let empty = paint.projected_bounds_for_range(&shaped("", &[]), 0, 0..0);
    assert_eq!(empty.left(), paint.viewport.bounds.left());
}

#[test]
fn scrolled_pointer_and_native_point_queries_use_the_painted_byte_positions() {
    let paint = painted_unicode();
    assert_eq!(paint.viewport.offset, px(52.));
    // The visible x=53 is line x=65, the B after a four-byte emoji and
    // combining sequence. Forgetting the inverse offset selects the emoji.
    let position = point(px(53.), px(30.));
    assert_eq!(painted_index(&paint, &paint.line.text, position), Some(8));
    assert_eq!(paint.character_index(&paint.line.text, position), Some(8));
    assert_eq!(
        paint.viewport.window_x(paint.line.x_for_index(8)),
        position.x
    );
    assert_eq!(
        paint.character_index(&paint.line.text, point(px(39.), px(30.))),
        None
    );
    assert_eq!(
        painted_index(&paint, &paint.line.text, point(px(39.), px(10.))),
        Some(0)
    );
    assert_eq!(
        painted_index(&paint, &paint.line.text, point(px(91.), px(50.))),
        Some(10)
    );
}

#[test]
fn native_range_geometry_and_selection_share_translation_and_viewport_clipping() {
    let paint = painted_unicode();
    let selected = paint.bounds_for_range(&paint.line.text, 8..9).unwrap();
    assert_eq!(
        selected,
        Bounds::new(point(px(53.), px(20.)), size(px(15.), px(24.)))
    );
    let whole = paint.bounds_for_range(&paint.line.text, 0..10).unwrap();
    assert_eq!(
        whole,
        Bounds::new(point(px(40.), px(20.)), size(px(48.), px(24.)))
    );
    let hidden = paint.bounds_for_range(&paint.line.text, 0..1).unwrap();
    assert_eq!(hidden.size.width, px(0.));
    assert_eq!(hidden.left(), paint.viewport.bounds.left());
    let caret = paint.bounds_for_range(&paint.line.text, 10..10).unwrap();
    assert_eq!(caret.left(), paint.viewport.bounds.right() - CARET_WIDTH);
    assert_eq!(caret.size.width, px(0.));
}

#[test]
fn edited_text_cannot_reuse_old_glyph_byte_offsets_before_the_next_paint() {
    let paint = painted_unicode();
    for replacement in ["", "🌍", "A🌍", "A🌍e\u{301}BD"] {
        assert_eq!(
            painted_index(&paint, replacement, point(px(53.), px(30.))),
            None
        );
        assert_eq!(
            paint.character_index(replacement, point(px(53.), px(30.))),
            None
        );
        assert_eq!(
            paint.bounds_for_range(replacement, 0..replacement.len()),
            None
        );
        assert!(paint.snapshot(replacement).is_none());
    }
    // Same-content styling retains valid geometry until its next real paint.
    assert!(
        paint
            .character_index(&paint.line.text, point(px(53.), px(30.)))
            .is_some()
    );
}

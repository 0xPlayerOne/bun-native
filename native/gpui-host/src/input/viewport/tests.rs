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
    }
}

#[test]
fn scrolled_pointer_and_native_point_queries_use_the_painted_byte_positions() {
    let paint = painted_unicode();
    assert_eq!(paint.viewport.offset, px(52.));
    // The visible x=53 is line x=65, the B after a four-byte emoji and
    // combining sequence. Forgetting the inverse offset selects the emoji.
    let position = point(px(53.), px(30.));
    assert_eq!(paint.mouse_index(&paint.line.text, position), Some(8));
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
        paint.mouse_index(&paint.line.text, point(px(39.), px(10.))),
        Some(0)
    );
    assert_eq!(
        paint.mouse_index(&paint.line.text, point(px(91.), px(50.))),
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
            paint.mouse_index(replacement, point(px(53.), px(30.))),
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

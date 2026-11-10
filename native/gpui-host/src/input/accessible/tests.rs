use super::*;
use gpui::{Bounds, point, px, size};

fn viewport(offset: f32) -> TextViewport {
    TextViewport {
        bounds: Bounds::new(point(px(10.), px(20.)), size(px(100.), px(24.))),
        offset: px(offset),
    }
}

/// One glyph per listed byte offset, `advance` px apart in the given order.
fn glyphs(order: &[usize], advance: f32) -> Vec<PaintedGlyph> {
    order
        .iter()
        .enumerate()
        .map(|(slot, index)| PaintedGlyph {
            x: px(slot as f32 * advance),
            index: *index,
        })
        .collect()
}

fn no_caret(_: usize) -> gpui::Pixels {
    panic!("every character has a glyph")
}

#[test]
fn geometry_follows_painted_left_to_right_glyphs_at_physical_scale() {
    // "ab" + decomposed e-acute: three characters; the mark is its own glyph.
    let content = "abe\u{301}";
    let lengths = accessible_characters(content);
    assert_eq!(lengths, [1, 1, 3]);
    let geometry = run_geometry(
        &lengths,
        viewport(0.),
        2.,
        glyphs(&[0, 1, 2, 3], 7.),
        px(28.),
        no_caret,
    );
    assert_eq!(geometry.positions, [0., 14., 28.]);
    assert_eq!(geometry.widths, [14., 14., 28.]);
    assert_eq!(
        geometry.bounds,
        accesskit::Rect {
            x0: 20.,
            y0: 40.,
            x1: 220.,
            y1: 88.,
        }
    );
}

#[test]
fn geometry_keeps_scrolled_glyph_offsets_outside_the_viewport() {
    let lengths = accessible_characters("abcd");
    let geometry = run_geometry(
        &lengths,
        viewport(15.),
        1.,
        glyphs(&[0, 1, 2, 3], 10.),
        px(40.),
        no_caret,
    );
    assert_eq!(geometry.positions, [-15., -5., 5., 15.]);
    assert_eq!(geometry.widths, [10.; 4]);
}

#[test]
fn right_to_left_glyphs_are_exposed_where_they_are_painted() {
    // "Ca " then two Hebrew letters (two bytes each) shaped right to left:
    // the visual order is C, a, space, then the second letter, then the first.
    let lengths = accessible_characters("Ca \u{5e9}\u{5dc}");
    let geometry = run_geometry(
        &lengths,
        viewport(0.),
        1.,
        glyphs(&[0, 1, 2, 5, 3], 10.),
        px(50.),
        no_caret,
    );
    assert_eq!(geometry.positions, [0., 10., 20., 40., 30.]);
    assert_eq!(geometry.widths, [10.; 5]);
}

#[test]
fn characters_without_their_own_glyph_are_empty_boxes_at_the_caret() {
    // A two-character ligature shaped as one glyph from byte 0.
    let lengths = accessible_characters("fi");
    let geometry = run_geometry(
        &lengths,
        viewport(0.),
        1.,
        glyphs(&[0], 12.),
        px(12.),
        |index| px(index as f32 * 6.),
    );
    assert_eq!(geometry.positions, [0., 6.]);
    assert_eq!(geometry.widths, [12., 0.]);
}

#[test]
fn requested_selections_map_grapheme_indices_to_byte_offsets() {
    let content = "a\u{1f1fa}\u{1f1f8}b";
    let at = |anchor, focus| accesskit::TextSelection {
        anchor: accesskit::TextPosition {
            node: accesskit::NodeId(1),
            character_index: anchor,
        },
        focus: accesskit::TextPosition {
            node: accesskit::NodeId(1),
            character_index: focus,
        },
    };
    // A caret after the flag, which is one character of eight bytes.
    assert_eq!(requested_selection(content, &at(2, 2)), Selection::caret(9));
    let forward = requested_selection(content, &at(0, 2));
    assert_eq!((forward.range, forward.reversed), (0..9, false));
    let backward = requested_selection(content, &at(3, 1));
    assert_eq!((backward.range, backward.reversed), (1..10, true));
    // Indices past the end clamp to it.
    assert_eq!(
        requested_selection(content, &at(9, 9)),
        Selection::caret(10)
    );
}

#[test]
fn exposed_selection_reports_anchor_and_active_end() {
    let selection = Selection {
        range: 1..9,
        reversed: true,
    };
    let text = AccessibleText::new("a\u{1f1fa}\u{1f1f8}b", &selection, |_| None);
    assert_eq!((text.anchor, text.focus), (2, 1));
    assert_eq!(text.lengths, [1, 8, 1]);
    assert!(text.geometry.is_none());
}

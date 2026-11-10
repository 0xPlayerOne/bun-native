//! The AccessKit text run of a native input, and the edits an assistive
//! technology may request through it. Characters are grapheme clusters, as in
//! caret motion; geometry comes only from the latest actual paint of the same
//! text, so a stale glyph position is never exposed.

use super::editing::{accessible_characters, accessible_index};
use super::selection::Selection;
use super::viewport::TextViewport;
use gpui::{Bounds, Pixels};

/// Each character's horizontal extent within the run's bounds, in physical
/// pixels. AccessKit reads these as left-to-right offsets from the run's left
/// edge, so a right-to-left character simply has a larger offset than the
/// character after it.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct RunGeometry {
    pub(super) bounds: accesskit::Rect,
    pub(super) positions: Vec<f32>,
    pub(super) widths: Vec<f32>,
}

/// Everything one frame exposes for an input's value.
pub(super) struct AccessibleText {
    pub(super) value: String,
    pub(super) lengths: Vec<u8>,
    pub(super) anchor: usize,
    pub(super) focus: usize,
    pub(super) geometry: Option<RunGeometry>,
}

impl AccessibleText {
    pub(super) fn new(
        content: &str,
        selection: &Selection,
        geometry: impl FnOnce(&[u8]) -> Option<RunGeometry>,
    ) -> Self {
        let lengths = accessible_characters(content);
        let index = |offset| accessible_index(&lengths, offset);
        let (anchor, focus) = if selection.reversed {
            (selection.range.end, selection.range.start)
        } else {
            (selection.range.start, selection.range.end)
        };
        let (anchor, focus) = (index(anchor), index(focus));
        let geometry = geometry(&lengths);
        Self {
            value: content.to_owned(),
            lengths,
            anchor,
            focus,
            geometry,
        }
    }

    /// Fill the input node and push its single text run.
    pub(super) fn write(self, builder: &mut gpui::A11ySubtreeBuilder) {
        let run_id = builder.synthetic_node_id(0);
        let mut run = accesskit::Node::new(accesskit::Role::TextRun);
        run.set_value(self.value);
        run.set_character_lengths(self.lengths);
        if let Some(geometry) = self.geometry {
            run.set_bounds(geometry.bounds);
            run.set_text_direction(accesskit::TextDirection::LeftToRight);
            run.set_character_positions(geometry.positions);
            run.set_character_widths(geometry.widths);
        }
        builder.push_child(run_id, run);
        let position = |character_index| accesskit::TextPosition {
            node: run_id,
            character_index,
        };
        builder
            .parent_node()
            .set_text_selection(accesskit::TextSelection {
                anchor: position(self.anchor),
                focus: position(self.focus),
            });
    }
}

/// One painted glyph: its x in the line, before the viewport scroll, and the
/// UTF-8 offset of the text it was shaped from.
#[derive(Clone, Copy, Debug)]
pub(super) struct PaintedGlyph {
    pub(super) x: Pixels,
    pub(super) index: usize,
}

/// The run's geometry from one painted line. Glyphs are taken in visual order;
/// each extends to the next glyph (the last to the line width), and a
/// character spans every glyph shaped from its bytes. Bidirectional text is
/// therefore exposed where it is painted: a right-to-left character lies to
/// the right of the character after it. A character with no glyph of its own
/// (inside a ligature) is an empty box at `caret_x`. Glyphs scrolled out of
/// the clipped viewport keep their true offsets, negative or past the right
/// edge, as the painted text does.
pub(super) fn run_geometry(
    lengths: &[u8],
    viewport: TextViewport,
    scale: f32,
    mut glyphs: Vec<PaintedGlyph>,
    line_width: Pixels,
    caret_x: impl Fn(usize) -> Pixels,
) -> RunGeometry {
    glyphs.sort_by(|a, b| f32::from(a.x).total_cmp(&f32::from(b.x)));
    let spans: Vec<(Pixels, Pixels, usize)> = glyphs
        .iter()
        .enumerate()
        .map(|(position, glyph)| {
            let right = glyphs
                .get(position + 1)
                .map_or(line_width, |next| next.x)
                .max(glyph.x);
            (glyph.x, right, glyph.index)
        })
        .collect();
    let mut positions = Vec::with_capacity(lengths.len());
    let mut widths = Vec::with_capacity(lengths.len());
    let mut start = 0;
    for length in lengths {
        let end = start + usize::from(*length);
        let (left, right) = spans
            .iter()
            .filter(|(_, _, index)| (start..end).contains(index))
            .fold(
                None,
                |extent: Option<(Pixels, Pixels)>, (left, right, _)| {
                    Some(extent.map_or((*left, *right), |(low, high)| {
                        (low.min(*left), high.max(*right))
                    }))
                },
            )
            .unwrap_or_else(|| {
                let x = caret_x(start);
                (x, x)
            });
        positions.push(f32::from(left - viewport.offset) * scale);
        widths.push(f32::from(right - left) * scale);
        start = end;
    }
    RunGeometry {
        bounds: physical(viewport.bounds, scale),
        positions,
        widths,
    }
}

/// GPUI reports accessible bounds in physical window pixels.
fn physical(bounds: Bounds<Pixels>, scale: f32) -> accesskit::Rect {
    let edge = |value: Pixels| f64::from(f32::from(value) * scale);
    accesskit::Rect {
        x0: edge(bounds.left()),
        y0: edge(bounds.top()),
        x1: edge(bounds.right()),
        y1: edge(bounds.bottom()),
    }
}

/// The UTF-8 offset of an accessible character index, clamped to the end.
pub(super) fn offset_of(lengths: &[u8], character_index: usize) -> usize {
    lengths
        .iter()
        .take(character_index)
        .map(|length| usize::from(*length))
        .sum()
}

/// The selection an assistive technology requested, in UTF-8 offsets. The
/// focus is the active end, as for Shift selection.
pub(super) fn requested_selection(content: &str, request: &accesskit::TextSelection) -> Selection {
    let lengths = accessible_characters(content);
    let anchor = offset_of(&lengths, request.anchor.character_index);
    let focus = offset_of(&lengths, request.focus.character_index);
    Selection {
        range: anchor.min(focus)..anchor.max(focus),
        reversed: focus < anchor,
    }
}

/// What a paint must match for the exposed geometry to be current. A
/// mismatch after paint asks for one more frame, which then exposes it.
#[derive(Clone, PartialEq)]
pub(super) struct GeometryKey {
    pub(super) text: gpui::SharedString,
    pub(super) viewport: TextViewport,
    pub(super) scale: f32,
}

#[cfg(test)]
mod tests;

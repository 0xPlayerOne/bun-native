//! Coordinates from one actual input paint, shared by drawing and native input.

use super::hit_test::{PaintedLine, painted_index};
use gpui::{Bounds, Pixels, Point, ShapedLine, point, px};
use std::ops::Range;

pub(super) const CARET_WIDTH: Pixels = gpui::px(2.);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct TextViewport {
    pub(super) bounds: Bounds<Pixels>,
    pub(super) offset: Pixels,
}

impl TextViewport {
    pub(super) fn new(
        bounds: Bounds<Pixels>,
        line_width: Pixels,
        caret: Pixels,
        previous_offset: Pixels,
    ) -> Self {
        // Reserve the painted caret width even at the end of the line. A
        // zero-width viewport remains valid and is entirely clipped at paint.
        let visible_width = (bounds.size.width - CARET_WIDTH).max(px(0.));
        let maximum = (line_width - visible_width).max(px(0.));
        let mut offset = previous_offset.max(px(0.)).min(maximum);
        if caret < offset {
            offset = caret.max(px(0.));
        } else if caret > offset + visible_width {
            offset = (caret - visible_width).min(maximum);
        }
        Self { bounds, offset }
    }

    pub(super) fn origin(self) -> Point<Pixels> {
        self.bounds.origin - point(self.offset, px(0.))
    }

    pub(super) fn window_x(self, line_x: Pixels) -> Pixels {
        self.bounds.left() + line_x - self.offset
    }

    fn line_x(self, window_x: Pixels) -> Pixels {
        window_x - self.bounds.left() + self.offset
    }

    pub(super) fn range_bounds(self, start: Pixels, end: Pixels) -> Bounds<Pixels> {
        let left = self.window_x(start.min(end));
        let right = self.window_x(start.max(end));
        Bounds::from_corners(
            point(
                left.max(self.bounds.left()).min(self.bounds.right()),
                self.bounds.top(),
            ),
            point(
                right.max(self.bounds.left()).min(self.bounds.right()),
                self.bounds.bottom(),
            ),
        )
    }
}

/// These fields are committed together only after the line has been painted.
pub(super) struct InputPaint {
    pub(super) line: ShapedLine,
    pub(super) viewport: TextViewport,
    pub(super) decorations: PaintedInputDecorations,
}

#[derive(Clone, PartialEq)]
pub(crate) struct PaintedInputDecorations {
    pub(crate) clip: Bounds<Pixels>,
    pub(crate) caret: Option<Bounds<Pixels>>,
    pub(crate) selection: Option<Bounds<Pixels>>,
    pub(crate) selected_bytes: [usize; 2],
    pub(crate) cursor_byte: usize,
}

#[derive(Clone, PartialEq)]
pub(crate) struct InputViewportSnapshot {
    pub(crate) viewport: Bounds<Pixels>,
    pub(crate) offset: Pixels,
    pub(crate) line_width: Pixels,
    pub(crate) decorations: PaintedInputDecorations,
}

impl InputPaint {
    pub(super) fn snapshot(&self, content: &str) -> Option<InputViewportSnapshot> {
        (self.line.text.as_ref() == content).then(|| InputViewportSnapshot {
            viewport: self.viewport.bounds,
            offset: self.viewport.offset,
            line_width: self.line.width(),
            decorations: self.decorations.clone(),
        })
    }

    pub(super) fn character_index(&self, content: &str, position: Point<Pixels>) -> Option<usize> {
        self.viewport.bounds.localize(&position)?;
        painted_index(self, content, position)
    }

    pub(super) fn bounds_for_range(
        &self,
        content: &str,
        range: Range<usize>,
    ) -> Option<Bounds<Pixels>> {
        if self.line.text.as_ref() != content {
            return None;
        }
        Some(self.viewport.range_bounds(
            self.line.x_for_index(range.start),
            self.line.x_for_index(range.end),
        ))
    }
}

impl InputPaint {
    /// What a later paint must match for this paint's exposed geometry.
    pub(super) fn geometry_key(&self, scale: f32) -> super::accessible::GeometryKey {
        super::accessible::GeometryKey {
            text: self.line.text.clone(),
            viewport: self.viewport,
            scale,
        }
    }

    /// Character bounds for accessibility, only when this paint shows `content`.
    pub(super) fn accessible_geometry(
        &self,
        content: &str,
        lengths: &[u8],
        scale: f32,
    ) -> Option<super::accessible::RunGeometry> {
        (self.line.text.as_ref() == content).then(|| {
            let glyphs = self
                .line
                .runs
                .iter()
                .flat_map(|run| &run.glyphs)
                .map(|glyph| super::accessible::PaintedGlyph {
                    x: glyph.position.x,
                    index: glyph.index,
                })
                .collect();
            super::accessible::run_geometry(
                lengths,
                self.viewport,
                scale,
                glyphs,
                self.line.width,
                |index| self.line.x_for_index(index),
            )
        })
    }
}

impl PaintedLine for InputPaint {
    fn text(&self) -> &str {
        &self.line.text
    }

    fn bounds(&self) -> Bounds<Pixels> {
        self.viewport.bounds
    }

    fn closest_index_for_window_x(&self, x: Pixels) -> usize {
        self.line.closest_index_for_x(self.viewport.line_x(x))
    }
}

#[cfg(test)]
mod tests;

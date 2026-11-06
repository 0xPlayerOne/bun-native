use bun_native_protocol::{
    AlignItems, Dimension, Direction, Element, JustifyContent, Overflow, Style,
};
use gpui::{
    AbsoluteLength, BoxShadow, FontWeight, Overflow as NativeOverflow, StyleRefinement, Styled, px,
    relative, rgb,
};

/// GPUI's `Styled` builders take the element by value, and a `Div` is over a
/// kilobyte, so chaining them on the element itself copies it at every call.
/// Refining the element's style through this borrow writes the same fields
/// without moving the element; see the ignored bench in the tests.
struct InPlace<'a>(&'a mut StyleRefinement);

impl Styled for InPlace<'_> {
    fn style(&mut self) -> &mut StyleRefinement {
        self.0
    }
}

/// Refine a freshly created element's style into the native default look of
/// its kind, overridden by the committed protocol style.
pub(crate) fn element(target: &mut StyleRefinement, element: &Element, root: bool) {
    let base = InPlace(target).flex_shrink_0();
    let base = match element {
        Element::Box { .. } if root => base.size_full().flex().flex_col(),
        Element::Box { .. } | Element::Overlay { .. } => base.flex().flex_col(),
        // The style may turn the axis; a split lays out in a row otherwise.
        Element::Split { .. } => base.flex().flex_row(),
        Element::Text { .. } => base,
        Element::Button { disabled, .. } => base
            .flex()
            .items_center()
            .justify_center()
            .h(px(44.))
            .px(px(12.))
            .bg(rgb(if *disabled { 0x7a8396 } else { 0x2255cc }))
            .text_color(rgb(0xffffff)),
        Element::Input { disabled, .. } => {
            base.bg(rgb(if *disabled { 0xe5e7eb } else { 0xffffff }))
        }
    };
    apply(base, element.style());
}

/// Values have already passed protocol bounds. Convert to GPUI pixels only
/// here, after f64 validation, so rounding cannot admit out-of-range values.
fn apply<T: Styled>(mut element: T, style: &Style) -> T {
    if let Some(direction) = style.direction {
        element = match direction {
            Direction::Row => element.flex().flex_row(),
            Direction::Column => element.flex().flex_col(),
        };
    }
    if let Some(gap) = style.gap {
        element = element.gap(px(gap as f32));
    }
    if let Some(padding) = style.padding {
        element = element.p(px(padding as f32));
    }
    if let Some(width) = style.width {
        element = match width {
            Dimension::Pixels(value) => element.w(px(value as f32)),
            Dimension::Fill(_) => element.w(relative(1.)),
        };
    }
    if let Some(height) = style.height {
        element = match height {
            Dimension::Pixels(value) => element.h(px(value as f32)),
            Dimension::Fill(_) => element.h(relative(1.)),
        };
    }
    if let Some(grow) = style.flex_grow {
        element = element.flex_grow(grow as f32);
    }
    if let Some(shrink) = style.flex_shrink {
        element = element.flex_shrink(shrink as f32);
    }
    if let Some(value) = style.min_width {
        element = element.min_w(px(value as f32));
    }
    if let Some(value) = style.max_width {
        element = element.max_w(px(value as f32));
    }
    if let Some(value) = style.min_height {
        element = element.min_h(px(value as f32));
    }
    if let Some(value) = style.max_height {
        element = element.max_h(px(value as f32));
    }
    if let Some(alignment) = style.align_items {
        element = match alignment {
            AlignItems::Start => element.items_start(),
            AlignItems::Center => element.items_center(),
            AlignItems::End => element.items_end(),
            AlignItems::Stretch => element.items_stretch(),
        };
    }
    if let Some(justification) = style.justify_content {
        element = match justification {
            JustifyContent::Start => element.justify_start(),
            JustifyContent::Center => element.justify_center(),
            JustifyContent::End => element.justify_end(),
            JustifyContent::SpaceBetween => element.justify_between(),
            JustifyContent::SpaceAround => element.justify_around(),
            JustifyContent::SpaceEvenly => element.justify_evenly(),
        };
    }
    if let Some(overflow) = style.overflow {
        // Non-visible native modes clip both axes. The contract deliberately
        // does not expose CSS's mixed visible/scroll axis semantics.
        let (x, y) = match overflow {
            Overflow::Visible => (NativeOverflow::Visible, NativeOverflow::Visible),
            Overflow::Hidden => (NativeOverflow::Hidden, NativeOverflow::Hidden),
            Overflow::ScrollX => (NativeOverflow::Scroll, NativeOverflow::Hidden),
            Overflow::ScrollY => (NativeOverflow::Hidden, NativeOverflow::Scroll),
            Overflow::Scroll => (NativeOverflow::Scroll, NativeOverflow::Scroll),
        };
        element.style().overflow.x = Some(x);
        element.style().overflow.y = Some(y);
    }
    if let Some(background) = style.background {
        element = element.bg(rgb(background));
    }
    if let Some(color) = style.color {
        element = element.text_color(rgb(color));
    }
    if let Some(size) = style.font_size {
        element = element.text_size(px(size as f32));
    }
    if let Some(width) = style.border_width {
        let width = AbsoluteLength::from(px(width as f32));
        let edges = &mut element.style().border_widths;
        edges.top = Some(width);
        edges.right = Some(width);
        edges.bottom = Some(width);
        edges.left = Some(width);
    }
    if let Some(color) = style.border_color {
        element.style().border_color = Some(rgb(color).into());
    }
    if let Some(radius) = style.corner_radius {
        let radius = AbsoluteLength::from(px(radius as f32));
        let corners = &mut element.style().corner_radii;
        corners.top_left = Some(radius);
        corners.top_right = Some(radius);
        corners.bottom_right = Some(radius);
        corners.bottom_left = Some(radius);
    }
    if let Some(opacity) = style.opacity {
        element = element.opacity(opacity as f32);
    }
    if let Some(weight) = style.font_weight {
        element = element.font_weight(FontWeight(weight as f32));
    }
    element
}

/// The keyboard focus indicator: a 1-pixel white edge over a 2-pixel dark
/// band, inset so ancestor clipping never hides it and layout never moves.
/// The pair stays visible on light and dark control backgrounds alike.
pub(crate) const FOCUS_RING_WIDTH: f32 = 3.;

pub(crate) fn focus_ring() -> Vec<BoxShadow> {
    vec![
        BoxShadow::new(px(0.), px(0.), rgb(0x101828).into())
            .spread_radius(px(FOCUS_RING_WIDTH))
            .inset(),
        BoxShadow::new(px(0.), px(0.), rgb(0xffffff).into())
            .spread_radius(px(1.))
            .inset(),
    ]
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod unit_tests;

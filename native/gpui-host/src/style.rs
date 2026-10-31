use bun_native_protocol::{AlignItems, Dimension, Direction, JustifyContent, Overflow, Style};
use gpui::{Overflow as NativeOverflow, Styled, px, relative, rgb};

/// Values have already passed protocol bounds. Convert to GPUI pixels only
/// here, after f64 validation, so rounding cannot admit out-of-range values.
pub(crate) fn apply<T: Styled>(mut element: T, style: &Style) -> T {
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
    element
}

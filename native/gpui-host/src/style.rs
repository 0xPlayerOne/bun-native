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

#[cfg(test)]
mod tests {
    use super::*;
    use bun_native_protocol::Fill;
    use gpui::{Div, StyleRefinement, div};

    fn applied(style: &Style) -> StyleRefinement {
        apply(div(), style).style().clone()
    }

    fn native(build: impl FnOnce(Div) -> Div) -> StyleRefinement {
        build(div()).style().clone()
    }

    #[test]
    fn an_empty_style_leaves_the_element_untouched() {
        assert_eq!(applied(&Style::default()), native(|element| element));
    }

    #[test]
    fn direction_enables_flex_layout_on_the_matching_axis() {
        let row = applied(&Style {
            direction: Some(Direction::Row),
            ..Style::default()
        });
        assert_eq!(row.display, Some(gpui::Display::Flex));
        assert_eq!(row.flex_direction, Some(gpui::FlexDirection::Row));
        let column = applied(&Style {
            direction: Some(Direction::Column),
            ..Style::default()
        });
        assert_eq!(column.display, Some(gpui::Display::Flex));
        assert_eq!(column.flex_direction, Some(gpui::FlexDirection::Column));
    }

    #[test]
    fn numeric_properties_map_to_their_gpui_counterparts() {
        type Case = (Style, fn(Div) -> Div);
        let cases: [Case; 9] = [
            (
                Style {
                    gap: Some(8.5),
                    ..Style::default()
                },
                |element| element.gap(px(8.5)),
            ),
            (
                Style {
                    padding: Some(12.),
                    ..Style::default()
                },
                |element| element.p(px(12.)),
            ),
            (
                Style {
                    flex_grow: Some(2.),
                    ..Style::default()
                },
                |element| element.flex_grow(2.),
            ),
            (
                Style {
                    flex_shrink: Some(0.),
                    ..Style::default()
                },
                |element| element.flex_shrink(0.),
            ),
            (
                Style {
                    min_width: Some(10.),
                    ..Style::default()
                },
                |element| element.min_w(px(10.)),
            ),
            (
                Style {
                    max_width: Some(20.),
                    ..Style::default()
                },
                |element| element.max_w(px(20.)),
            ),
            (
                Style {
                    min_height: Some(30.),
                    ..Style::default()
                },
                |element| element.min_h(px(30.)),
            ),
            (
                Style {
                    max_height: Some(40.),
                    ..Style::default()
                },
                |element| element.max_h(px(40.)),
            ),
            (
                Style {
                    font_size: Some(17.),
                    ..Style::default()
                },
                |element| element.text_size(px(17.)),
            ),
        ];
        for (style, expected) in cases {
            assert_eq!(applied(&style), native(expected), "{style:?}");
        }
    }

    #[test]
    fn dimensions_are_pixels_or_the_full_parent_extent() {
        let pixels = Style {
            width: Some(Dimension::Pixels(120.)),
            height: Some(Dimension::Pixels(0.)),
            ..Style::default()
        };
        assert_eq!(
            applied(&pixels),
            native(|element| element.w(px(120.)).h(px(0.)))
        );
        let fill = Style {
            width: Some(Dimension::Fill(Fill::Fill)),
            height: Some(Dimension::Fill(Fill::Fill)),
            ..Style::default()
        };
        assert_eq!(
            applied(&fill),
            native(|element| element.w(relative(1.)).h(relative(1.)))
        );
    }

    #[test]
    fn alignment_and_justification_cover_every_protocol_variant() {
        for (alignment, expected) in [
            (AlignItems::Start, gpui::AlignItems::FlexStart),
            (AlignItems::Center, gpui::AlignItems::Center),
            (AlignItems::End, gpui::AlignItems::FlexEnd),
            (AlignItems::Stretch, gpui::AlignItems::Stretch),
        ] {
            let style = applied(&Style {
                align_items: Some(alignment),
                ..Style::default()
            });
            assert_eq!(style.align_items, Some(expected), "{alignment:?}");
        }
        for (justification, expected) in [
            (JustifyContent::Start, gpui::JustifyContent::Start),
            (JustifyContent::Center, gpui::JustifyContent::Center),
            (JustifyContent::End, gpui::JustifyContent::End),
            (
                JustifyContent::SpaceBetween,
                gpui::JustifyContent::SpaceBetween,
            ),
            (
                JustifyContent::SpaceAround,
                gpui::JustifyContent::SpaceAround,
            ),
            (
                JustifyContent::SpaceEvenly,
                gpui::JustifyContent::SpaceEvenly,
            ),
        ] {
            let style = applied(&Style {
                justify_content: Some(justification),
                ..Style::default()
            });
            assert_eq!(style.justify_content, Some(expected), "{justification:?}");
        }
    }

    #[test]
    fn non_visible_overflow_clips_both_axes() {
        for (overflow, x, y) in [
            (
                Overflow::Visible,
                NativeOverflow::Visible,
                NativeOverflow::Visible,
            ),
            (
                Overflow::Hidden,
                NativeOverflow::Hidden,
                NativeOverflow::Hidden,
            ),
            (
                Overflow::ScrollX,
                NativeOverflow::Scroll,
                NativeOverflow::Hidden,
            ),
            (
                Overflow::ScrollY,
                NativeOverflow::Hidden,
                NativeOverflow::Scroll,
            ),
            (
                Overflow::Scroll,
                NativeOverflow::Scroll,
                NativeOverflow::Scroll,
            ),
        ] {
            let style = applied(&Style {
                overflow: Some(overflow),
                ..Style::default()
            });
            assert_eq!(style.overflow.x, Some(x), "{overflow:?}");
            assert_eq!(style.overflow.y, Some(y), "{overflow:?}");
        }
    }

    #[test]
    fn colors_are_opaque_rgb_for_background_and_text() {
        let style = Style {
            background: Some(0x2255cc),
            color: Some(0xffffff),
            ..Style::default()
        };
        assert_eq!(
            applied(&style),
            native(|element| element.bg(rgb(0x2255cc)).text_color(rgb(0xffffff)))
        );
        let black = applied(&Style {
            color: Some(0),
            ..Style::default()
        });
        assert_eq!(black.text.color.map(|color| color.a), Some(1.));
    }

    #[test]
    fn protocol_style_refines_rather_than_replaces_host_defaults() {
        let base = || div().flex().items_center().p(px(4.));
        let refined = apply(
            base(),
            &Style {
                padding: Some(9.),
                ..Style::default()
            },
        )
        .style()
        .clone();
        assert_eq!(refined, base().p(px(9.)).style().clone());
        assert_eq!(refined.align_items, Some(gpui::AlignItems::Center));
    }
}

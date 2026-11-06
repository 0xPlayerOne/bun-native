//! Maps a window point to a UTF-8 byte index in `TextInput` content using only
//! the metrics of the last painted line, so it can be tested without GPUI.

use gpui::{Bounds, Pixels, Point};

/// What hit testing needs from the line committed by the last paint.
pub(super) trait PaintedLine {
    /// The text the line was laid out for.
    fn text(&self) -> &str;
    /// The visible viewport of the line, in window coordinates.
    fn bounds(&self) -> Bounds<Pixels>;
    /// The closest byte index to a window x coordinate on the line.
    fn closest_index_for_window_x(&self, x: Pixels) -> usize;
}

/// The byte index under `position`, or `None` when `line` was laid out for
/// other text. Points above the line map to the start and below it to the end.
pub(super) fn painted_index(
    line: &impl PaintedLine,
    content: &str,
    position: Point<Pixels>,
) -> Option<usize> {
    if line.text() != content {
        return None;
    }
    let bounds = line.bounds();
    if position.y < bounds.top() {
        return Some(0);
    }
    if position.y > bounds.bottom() {
        return Some(content.len());
    }
    Some(line.closest_index_for_window_x(position.x))
}

/// The byte index a mouse press or drag at `position` targets.
///
/// An edit can arrive before the next paint. Never interpret old glyph byte
/// indices against new text; retain the current caret (`cursor`) instead.
pub(super) fn index_for_mouse_position(
    content: &str,
    line: Option<&impl PaintedLine>,
    position: Point<Pixels>,
    cursor: usize,
) -> usize {
    if content.is_empty() {
        return 0;
    }
    line.and_then(|line| painted_index(line, content, position))
        .unwrap_or(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, px, size};

    /// A monospace line: every char is 10px wide, laid out from `left` in a
    /// viewport spanning y 20..44. Indices snap to the nearest char boundary.
    struct Monospace {
        text: &'static str,
        left: f32,
    }

    impl PaintedLine for Monospace {
        fn text(&self) -> &str {
            self.text
        }

        fn bounds(&self) -> Bounds<Pixels> {
            Bounds::new(point(px(40.), px(20.)), size(px(100.), px(24.)))
        }

        fn closest_index_for_window_x(&self, x: Pixels) -> usize {
            let column = ((f32::from(x) - self.left) / 10.).round().max(0.) as usize;
            self.text
                .char_indices()
                .map(|(index, _)| index)
                .chain([self.text.len()])
                .nth(column)
                .unwrap_or(self.text.len())
        }
    }

    // "a" (1 byte), "é" (2), "界" (3), "🌍" (4).
    const TEXT: &str = "aé界🌍";

    fn line() -> Monospace {
        Monospace {
            text: TEXT,
            left: 40.,
        }
    }

    fn at(x: f32, y: f32) -> Point<Pixels> {
        point(px(x), px(y))
    }

    #[test]
    fn points_on_the_line_snap_to_multibyte_character_boundaries() {
        let line = line();
        for (x, index) in [(40., 0), (50., 1), (54., 1), (56., 3), (60., 3), (70., 6)] {
            assert_eq!(painted_index(&line, TEXT, at(x, 30.)), Some(index), "x {x}");
        }
        assert_eq!(painted_index(&line, TEXT, at(80., 30.)), Some(TEXT.len()));
    }

    #[test]
    fn points_left_or_right_of_the_text_clamp_to_its_ends() {
        let line = line();
        assert_eq!(painted_index(&line, TEXT, at(0., 30.)), Some(0));
        assert_eq!(painted_index(&line, TEXT, at(-1e6, 30.)), Some(0));
        assert_eq!(painted_index(&line, TEXT, at(500., 30.)), Some(TEXT.len()));
    }

    #[test]
    fn points_above_or_below_the_line_select_to_the_start_or_end() {
        let line = line();
        // Vertical overflow wins over x, including x past the opposite end.
        assert_eq!(painted_index(&line, TEXT, at(500., 19.)), Some(0));
        assert_eq!(painted_index(&line, TEXT, at(0., 45.)), Some(TEXT.len()));
        // The bounds' edges are still on the line.
        assert_eq!(painted_index(&line, TEXT, at(50., 20.)), Some(1));
        assert_eq!(painted_index(&line, TEXT, at(50., 44.)), Some(1));
    }

    #[test]
    fn a_scrolled_line_hit_tests_in_window_coordinates() {
        // The line starts 25px left of the viewport.
        let line = Monospace {
            text: TEXT,
            left: 15.,
        };
        assert_eq!(painted_index(&line, TEXT, at(40., 30.)), Some(6));
    }

    #[test]
    fn stale_layouts_are_never_read_against_new_text() {
        let line = line();
        for edited in ["", "a", "aé界", "aé界🌍!"] {
            assert_eq!(painted_index(&line, edited, at(60., 30.)), None);
        }
        assert_eq!(
            index_for_mouse_position("ab", Some(&line), at(60., 30.), 1),
            1
        );
    }

    #[test]
    fn mouse_index_uses_the_painted_line_when_it_matches() {
        let line = line();
        assert_eq!(
            index_for_mouse_position(TEXT, Some(&line), at(60., 30.), 0),
            3
        );
        assert_eq!(
            index_for_mouse_position(TEXT, Some(&line), at(60., 0.), 6),
            0
        );
    }

    #[test]
    fn mouse_index_keeps_the_caret_before_the_first_paint() {
        assert_eq!(
            index_for_mouse_position(TEXT, None::<&Monospace>, at(60., 30.), 6),
            6
        );
    }

    #[test]
    fn empty_content_always_maps_to_zero() {
        let empty = Monospace {
            text: "",
            left: 40.,
        };
        assert_eq!(
            index_for_mouse_position("", Some(&empty), at(500., 50.), 0),
            0
        );
        // Even if the line was painted for other text (e.g. a placeholder).
        assert_eq!(
            index_for_mouse_position("", Some(&line()), at(60., 30.), 0),
            0
        );
        assert_eq!(
            index_for_mouse_position("", None::<&Monospace>, at(0., 0.), 3),
            0
        );
    }
}

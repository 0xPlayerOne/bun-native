//! Pure selection state for `TextInput`: an ordered UTF-8 byte range plus which
//! end is active. Every transition here is independent of GPUI.

use super::offsets;
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Selection {
    /// Always ordered: `range.start <= range.end`.
    pub(super) range: Range<usize>,
    /// True when the active end (the caret) is `range.start`.
    pub(super) reversed: bool,
}

impl Selection {
    pub(super) fn caret(offset: usize) -> Self {
        Self {
            range: offset..offset,
            reversed: false,
        }
    }

    /// The active end of the selection, where the caret is drawn.
    pub(super) fn cursor(&self) -> usize {
        if self.reversed {
            self.range.start
        } else {
            self.range.end
        }
    }

    /// Moves the active end to `offset`, keeping the anchor. Crossing the
    /// anchor flips which end is active so the range stays ordered.
    pub(super) fn select_to(&mut self, offset: usize) {
        if self.reversed {
            self.range.start = offset
        } else {
            self.range.end = offset
        };
        if self.range.end < self.range.start {
            self.reversed = !self.reversed;
            self.range = self.range.end..self.range.start;
        }
    }

    /// Left arrow: collapses a selection to its start, otherwise moves the
    /// caret back one grapheme cluster.
    pub(super) fn move_left(&mut self, content: &str) {
        let offset = if self.range.is_empty() {
            offsets::previous_boundary(content, self.cursor())
        } else {
            self.range.start
        };
        *self = Self::caret(offset);
    }

    /// Right arrow: collapses a selection to its end, otherwise moves the
    /// caret forward one grapheme cluster.
    pub(super) fn move_right(&mut self, content: &str) {
        let offset = if self.range.is_empty() {
            offsets::next_boundary(content, self.range.end)
        } else {
            self.range.end
        };
        *self = Self::caret(offset);
    }

    /// Shift-left: extends the active end back one grapheme cluster.
    pub(super) fn select_left(&mut self, content: &str) {
        self.select_to(offsets::previous_boundary(content, self.cursor()));
    }

    /// Shift-right: extends the active end forward one grapheme cluster.
    pub(super) fn select_right(&mut self, content: &str) {
        self.select_to(offsets::next_boundary(content, self.cursor()));
    }

    pub(super) fn select_all(content: &str) -> Self {
        let mut selection = Self::caret(0);
        selection.select_to(content.len());
        selection
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(range: Range<usize>, reversed: bool) -> Selection {
        Selection { range, reversed }
    }

    // "a" (1 byte), "e" + combining acute (3 bytes, one cluster), "🌍" (4), "b" (1).
    const TEXT: &str = "ae\u{301}🌍b";

    #[test]
    fn caret_is_empty_and_forward() {
        let caret = Selection::caret(4);
        assert_eq!(caret, selection(4..4, false));
        assert_eq!(caret.cursor(), 4);
    }

    #[test]
    fn cursor_is_the_active_end() {
        assert_eq!(selection(2..6, false).cursor(), 6);
        assert_eq!(selection(2..6, true).cursor(), 2);
    }

    #[test]
    fn select_to_extends_forward_from_the_anchor() {
        let mut s = Selection::caret(2);
        s.select_to(5);
        assert_eq!(s, selection(2..5, false));
        s.select_to(7);
        assert_eq!(s, selection(2..7, false));
        // Shrinking back toward the anchor keeps the direction.
        s.select_to(3);
        assert_eq!(s, selection(2..3, false));
        s.select_to(2);
        assert_eq!(s, selection(2..2, false));
    }

    #[test]
    fn select_to_before_the_anchor_reverses_and_keeps_the_range_ordered() {
        let mut s = Selection::caret(5);
        s.select_to(1);
        assert_eq!(s, selection(1..5, true));
        assert_eq!(s.cursor(), 1);
        // Moving the reversed active end keeps the anchor at 5.
        s.select_to(0);
        assert_eq!(s, selection(0..5, true));
        s.select_to(4);
        assert_eq!(s, selection(4..5, true));
        // Crossing the anchor again flips back to forward.
        s.select_to(8);
        assert_eq!(s, selection(5..8, false));
        assert_eq!(s.cursor(), 8);
    }

    #[test]
    fn select_to_the_anchor_from_a_reversed_selection_stays_reversed() {
        let mut s = selection(1..5, true);
        s.select_to(5);
        assert_eq!(s, selection(5..5, true));
        assert_eq!(s.cursor(), 5);
    }

    #[test]
    fn arrows_collapse_a_selection_to_its_edge_without_moving() {
        for reversed in [false, true] {
            let mut left = selection(1..4, reversed);
            left.move_left(TEXT);
            assert_eq!(left, Selection::caret(1));
            let mut right = selection(1..4, reversed);
            right.move_right(TEXT);
            assert_eq!(right, Selection::caret(4));
        }
    }

    #[test]
    fn arrows_move_a_caret_by_whole_grapheme_clusters() {
        let stops = [0, 1, 4, 8, TEXT.len()];
        let mut s = Selection::caret(0);
        for &stop in &stops[1..] {
            s.move_right(TEXT);
            assert_eq!(s, Selection::caret(stop));
        }
        s.move_right(TEXT);
        assert_eq!(s, Selection::caret(TEXT.len()), "saturates at the end");
        for &stop in stops[..stops.len() - 1].iter().rev() {
            s.move_left(TEXT);
            assert_eq!(s, Selection::caret(stop));
        }
        s.move_left(TEXT);
        assert_eq!(s, Selection::caret(0), "saturates at the start");
    }

    #[test]
    fn shift_arrows_extend_by_clusters_and_reverse_through_the_anchor() {
        let mut s = Selection::caret(4);
        s.select_right(TEXT);
        assert_eq!(s, selection(4..8, false));
        s.select_right(TEXT);
        assert_eq!(s, selection(4..9, false));
        s.select_right(TEXT);
        assert_eq!(s, selection(4..9, false), "saturates at the end");
        s.select_left(TEXT);
        s.select_left(TEXT);
        assert_eq!(s, selection(4..4, false));
        s.select_left(TEXT);
        assert_eq!(s, selection(1..4, true));
        s.select_left(TEXT);
        assert_eq!(s, selection(0..4, true));
        s.select_left(TEXT);
        assert_eq!(s, selection(0..4, true), "saturates at the start");
        // Shift-right from a reversed selection shrinks from the active start.
        s.select_right(TEXT);
        assert_eq!(s, selection(1..4, true));
    }

    #[test]
    fn shift_arrows_on_empty_text_stay_at_zero() {
        let mut s = Selection::caret(0);
        s.select_left("");
        s.select_right("");
        s.move_left("");
        s.move_right("");
        assert_eq!(s, Selection::caret(0));
    }

    #[test]
    fn select_all_is_a_forward_selection_of_the_whole_content() {
        assert_eq!(Selection::select_all(TEXT), selection(0..TEXT.len(), false));
        assert_eq!(Selection::select_all(""), Selection::caret(0));
    }
}

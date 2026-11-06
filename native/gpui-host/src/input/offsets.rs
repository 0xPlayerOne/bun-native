//! Pure UTF-8/UTF-16 and grapheme offset arithmetic for `TextInput`. Platform
//! input methods speak UTF-16; the model stores UTF-8 byte offsets.

use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

/// The UTF-8 offset of the first character boundary at or after `offset`
/// UTF-16 units, clamped to the end of `content`.
pub(super) fn from_utf16(content: &str, offset: usize) -> usize {
    let mut utf8_offset = 0;
    let mut utf16_count = 0;

    for ch in content.chars() {
        if utf16_count >= offset {
            break;
        }
        utf16_count += ch.len_utf16();
        utf8_offset += ch.len_utf8();
    }

    utf8_offset
}

/// The UTF-16 offset of the first character boundary at or after `offset`
/// UTF-8 bytes, clamped to the end of `content`.
pub(super) fn to_utf16(content: &str, offset: usize) -> usize {
    let mut utf16_offset = 0;
    let mut utf8_count = 0;

    for ch in content.chars() {
        if utf8_count >= offset {
            break;
        }
        utf8_count += ch.len_utf8();
        utf16_offset += ch.len_utf16();
    }

    utf16_offset
}

pub(super) fn range_to_utf16(content: &str, range: &Range<usize>) -> Range<usize> {
    to_utf16(content, range.start)..to_utf16(content, range.end)
}

/// Platform ranges may arrive reversed; the model range is always ordered.
pub(super) fn range_from_utf16(content: &str, range_utf16: &Range<usize>) -> Range<usize> {
    let start = from_utf16(content, range_utf16.start);
    let end = from_utf16(content, range_utf16.end);
    start.min(end)..start.max(end)
}

pub(super) fn previous_boundary(content: &str, offset: usize) -> usize {
    content
        .grapheme_indices(true)
        .rev()
        .find_map(|(idx, _)| (idx < offset).then_some(idx))
        .unwrap_or(0)
}

pub(super) fn next_boundary(content: &str, offset: usize) -> usize {
    content
        .grapheme_indices(true)
        .find_map(|(idx, _)| (idx > offset).then_some(idx))
        .unwrap_or(content.len())
}

/// Pasted text for a single-line input: each line break (`\n`, `\r` or `\r\n`)
/// becomes one space, so a CRLF paste does not keep a carriage return or turn
/// into two spaces.
pub(super) fn single_line_paste(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(' ');
            }
            '\n' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // "a" (1 byte, 1 unit), "é" (2, 1), "界" (3, 1), "🌍" (4, 2).
    const MIXED: &str = "aé界🌍";

    #[test]
    fn single_line_paste_turns_each_line_break_into_one_space() {
        assert_eq!(single_line_paste("a\nb"), "a b");
        assert_eq!(single_line_paste("a\r\nb"), "a b");
        assert_eq!(single_line_paste("a\rb"), "a b");
        assert_eq!(single_line_paste("a\r\n\r\nb\n"), "a  b ");
        assert_eq!(single_line_paste("\r\r\n"), "  ");
        assert_eq!(single_line_paste("界\r\n🌍"), "界 🌍");
        assert_eq!(single_line_paste(""), "");
    }

    #[test]
    fn utf16_and_utf8_offsets_round_trip_on_character_boundaries() {
        let pairs = [(0, 0), (1, 1), (3, 2), (6, 3), (10, 5)];
        for (utf8, utf16) in pairs {
            assert_eq!(to_utf16(MIXED, utf8), utf16, "utf8 {utf8}");
            assert_eq!(from_utf16(MIXED, utf16), utf8, "utf16 {utf16}");
        }
        assert_eq!(to_utf16("", 0), 0);
        assert_eq!(from_utf16("", 0), 0);
    }

    #[test]
    fn offsets_inside_a_character_round_up_to_its_end() {
        // Inside "é" and "界" (UTF-8) and between the surrogates of "🌍" (UTF-16).
        assert_eq!(to_utf16(MIXED, 2), 2);
        assert_eq!(to_utf16(MIXED, 4), 3);
        assert_eq!(to_utf16(MIXED, 7), 5);
        assert_eq!(from_utf16(MIXED, 4), 10);
    }

    #[test]
    fn out_of_range_offsets_clamp_to_the_content_end() {
        assert_eq!(to_utf16(MIXED, 11), 5);
        assert_eq!(to_utf16(MIXED, usize::MAX), 5);
        assert_eq!(from_utf16(MIXED, 6), MIXED.len());
        assert_eq!(from_utf16(MIXED, usize::MAX), MIXED.len());
        assert_eq!(from_utf16("", 3), 0);
    }

    #[test]
    fn ranges_convert_and_reversed_platform_ranges_are_ordered() {
        assert_eq!(range_to_utf16(MIXED, &(1..10)), 1..5);
        assert_eq!(range_from_utf16(MIXED, &(1..5)), 1..10);
        // A backwards selection from the platform is ordered.
        let reversed = std::ops::Range { start: 5, end: 1 };
        assert_eq!(range_from_utf16(MIXED, &reversed), 1..10);
        assert_eq!(range_from_utf16(MIXED, &(2..2)), 3..3);
        assert_eq!(range_from_utf16(MIXED, &(0..99)), 0..MIXED.len());
    }

    #[test]
    fn caret_moves_by_whole_grapheme_clusters() {
        // "e" + combining acute, a ZWJ family, and a flag are single clusters.
        let text = "ae\u{301}👨‍👩‍👧🇯🇵b";
        let family = "👨‍👩‍👧".len();
        let flag = "🇯🇵".len();
        let boundaries = [0, 1, 4, 4 + family, 4 + family + flag, text.len()];
        for pair in boundaries.windows(2) {
            assert_eq!(next_boundary(text, pair[0]), pair[1]);
            assert_eq!(previous_boundary(text, pair[1]), pair[0]);
        }
        // An offset inside a cluster moves to the cluster's own edges.
        assert_eq!(next_boundary(text, 2), 4);
        assert_eq!(previous_boundary(text, 2), 1);
    }

    #[test]
    fn caret_movement_saturates_at_both_ends() {
        assert_eq!(previous_boundary("abc", 0), 0);
        assert_eq!(next_boundary("abc", 3), 3);
        assert_eq!(next_boundary("abc", usize::MAX), 3);
        assert_eq!(previous_boundary("abc", usize::MAX), 2);
        assert_eq!(previous_boundary("", 0), 0);
        assert_eq!(next_boundary("", 0), 0);
    }

    #[test]
    fn crlf_is_one_cluster() {
        assert_eq!(next_boundary("a\r\nb", 1), 3);
        assert_eq!(previous_boundary("a\r\nb", 3), 1);
    }
}

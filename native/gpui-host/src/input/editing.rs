//! Pure text-offset rules shared by native editing, selection and platform IME.
//!
//! Byte offsets always fall on extended grapheme cluster boundaries for caret
//! movement and deletion, so combining marks, emoji ZWJ sequences, regional
//! indicator flags and Hangul jamo are edited as one user-perceived character.
//! Platform input handlers address text in UTF-16 code units; conversions clamp
//! to the content and never split a scalar value.

use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

/// The grapheme boundary strictly before `offset`, or 0.
pub(super) fn previous_boundary(content: &str, offset: usize) -> usize {
    content
        .grapheme_indices(true)
        .rev()
        .find_map(|(index, _)| (index < offset).then_some(index))
        .unwrap_or(0)
}

/// The grapheme boundary strictly after `offset`, or the content length.
pub(super) fn next_boundary(content: &str, offset: usize) -> usize {
    content
        .grapheme_indices(true)
        .find_map(|(index, _)| (index > offset).then_some(index))
        .unwrap_or(content.len())
}

/// A UTF-16 offset as a UTF-8 byte offset. An offset inside a surrogate pair
/// rounds up to the end of its scalar value; offsets past the end clamp.
pub(super) fn offset_from_utf16(content: &str, offset: usize) -> usize {
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

/// A UTF-8 byte offset as a UTF-16 offset.
pub(super) fn offset_to_utf16(content: &str, offset: usize) -> usize {
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
    offset_to_utf16(content, range.start)..offset_to_utf16(content, range.end)
}

/// Platform ranges may arrive reversed; the result is always ordered.
pub(super) fn range_from_utf16(content: &str, range: &Range<usize>) -> Range<usize> {
    let start = offset_from_utf16(content, range.start);
    let end = offset_from_utf16(content, range.end);
    start.min(end)..start.max(end)
}

/// AccessKit's selectable characters for a text run, in UTF-8 bytes: one per
/// grapheme cluster. A pathological cluster longer than a `u8` is split at
/// scalar boundaries so the lengths always sum to the content length.
pub(super) fn accessible_characters(content: &str) -> Vec<u8> {
    let mut lengths = Vec::new();
    for grapheme in content.graphemes(true) {
        if let Ok(length) = u8::try_from(grapheme.len()) {
            lengths.push(length);
            continue;
        }
        let mut chunk = 0;
        for ch in grapheme.chars() {
            if chunk + ch.len_utf8() > usize::from(u8::MAX) {
                lengths.push(chunk as u8);
                chunk = 0;
            }
            chunk += ch.len_utf8();
        }
        lengths.push(chunk as u8);
    }
    lengths
}

/// The number of accessible characters wholly before a byte offset.
pub(super) fn accessible_index(lengths: &[u8], offset: usize) -> usize {
    let mut end = 0;
    lengths
        .iter()
        .take_while(|length| {
            end += usize::from(**length);
            end <= offset
        })
        .count()
}

/// Whether a native or platform edit may change this input's value.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EditPolicy {
    pub(crate) disabled: bool,
    pub(crate) read_only: bool,
}

impl EditPolicy {
    /// Typing, deletion, paste, cut and IME composition.
    pub(super) fn editable(self) -> bool {
        !self.disabled && !self.read_only
    }

    /// Focus, caret movement, selection and copy.
    pub(super) fn interactive(self) -> bool {
        !self.disabled
    }
}

#[cfg(test)]
mod tests;

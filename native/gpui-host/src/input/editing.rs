//! Edit policy and accessibility text rules for native inputs. Grapheme and
//! UTF-16 offset conversions live in `offsets`.

use unicode_segmentation::UnicodeSegmentation;

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

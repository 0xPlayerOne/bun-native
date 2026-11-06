use super::*;

/// Every boundary reached by repeated Right from 0, then by repeated Left from the end.
fn walk(content: &str) -> (Vec<usize>, Vec<usize>) {
    let mut forward = vec![0];
    while *forward.last().unwrap() < content.len() {
        forward.push(next_boundary(content, *forward.last().unwrap()));
    }
    let mut backward = vec![content.len()];
    while *backward.last().unwrap() > 0 {
        backward.push(previous_boundary(content, *backward.last().unwrap()));
    }
    (forward, backward)
}

/// Backspace at `offset` exactly as the native action applies it.
fn backspace(content: &str, offset: usize) -> (String, usize) {
    let start = previous_boundary(content, offset);
    (content[..start].to_owned() + &content[offset..], start)
}

/// Forward delete at `offset` exactly as the native action applies it.
fn delete(content: &str, offset: usize) -> String {
    let end = next_boundary(content, offset);
    content[..offset].to_owned() + &content[end..]
}

#[test]
fn caret_moves_over_whole_user_perceived_characters() {
    let cases: &[(&str, &[usize])] = &[
        // Decomposed e + COMBINING ACUTE ACCENT, then a stacked double mark.
        ("e\u{301}x", &[0, 3, 4]),
        ("a\u{308}\u{332}b", &[0, 5, 6]),
        // Woman-woman-girl ZWJ family, then a skin-tone modifier sequence.
        ("\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}A", &[0, 18, 19]),
        ("\u{1f44d}\u{1f3fd}!", &[0, 8, 9]),
        // Two regional-indicator flags stay paired.
        ("\u{1f1fa}\u{1f1f8}\u{1f1eb}\u{1f1f7}", &[0, 8, 16]),
        // Conjoining Hangul jamo L+V+T and a precomposed syllable.
        ("\u{1100}\u{1161}\u{11a8}\u{d55c}", &[0, 9, 12]),
        // Hebrew and Arabic letters with points/harakat are logical-order clusters.
        ("\u{5e9}\u{5c1}\u{5dc}", &[0, 4, 6]),
        ("\u{628}\u{650}\u{633}\u{652}", &[0, 4, 8]),
        // CR LF is one grapheme; keycap sequence is one grapheme.
        ("\r\n1\u{fe0f}\u{20e3}", &[0, 2, 9]),
    ];
    for (content, boundaries) in cases {
        let (forward, mut backward) = walk(content);
        assert_eq!(&forward, boundaries, "{content:?}");
        backward.reverse();
        assert_eq!(&backward, boundaries, "{content:?}");
    }
}

#[test]
fn deletion_never_leaves_an_orphaned_mark_joiner_or_half_flag() {
    assert_eq!(backspace("Cafe\u{301}", 6), ("Caf".to_owned(), 3));
    assert_eq!(delete("Cafe\u{301}!", 3), "Caf!");
    let family = "\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}";
    assert_eq!(backspace(&format!("A{family}"), 19), ("A".to_owned(), 1));
    assert_eq!(delete(&format!("{family}B"), 0), "B");
    let flags = "\u{1f1fa}\u{1f1f8}\u{1f1eb}\u{1f1f7}";
    assert_eq!(backspace(flags, 16), ("\u{1f1fa}\u{1f1f8}".to_owned(), 8));
    // Arabic: deleting after a letter with a sukun removes the whole cluster.
    let arabic = "\u{633}\u{644}\u{627}\u{645}\u{652}";
    assert_eq!(
        backspace(arabic, arabic.len()),
        ("\u{633}\u{644}\u{627}".to_owned(), 6)
    );
    // An offset already at a boundary at either end stays put.
    assert_eq!(previous_boundary("", 0), 0);
    assert_eq!(next_boundary("ab", 2), 2);
}

#[test]
fn platform_utf16_offsets_never_split_scalar_values() {
    let content = "a\u{1f600}b\u{e9}";
    assert_eq!(content.encode_utf16().count(), 5);
    assert_eq!(offset_to_utf16(content, 0), 0);
    assert_eq!(offset_to_utf16(content, 1), 1);
    assert_eq!(offset_to_utf16(content, 5), 3);
    assert_eq!(offset_to_utf16(content, content.len()), 5);
    assert_eq!(offset_from_utf16(content, 3), 5);
    // The middle of the surrogate pair rounds forward to the scalar end.
    assert_eq!(offset_from_utf16(content, 2), 5);
    // Past-the-end platform offsets clamp to the content.
    assert_eq!(offset_from_utf16(content, 99), content.len());
    // Reversed ranges are ordered; round-trips are exact on scalar boundaries.
    let reversed = Range { start: 4, end: 1 };
    assert_eq!(range_from_utf16(content, &reversed), 1..6);
    for offset in [0, 1, 5, 6, content.len()] {
        assert_eq!(
            offset_from_utf16(content, offset_to_utf16(content, offset)),
            offset
        );
    }
    assert_eq!(range_to_utf16(content, &(1..5)), 1..3);
}

#[test]
fn disabled_and_read_only_states_bound_native_editing() {
    let normal = EditPolicy::default();
    assert!(normal.editable() && normal.interactive());
    let read_only = EditPolicy {
        read_only: true,
        ..EditPolicy::default()
    };
    assert!(!read_only.editable() && read_only.interactive());
    for read_only in [false, true] {
        let disabled = EditPolicy {
            disabled: true,
            read_only,
        };
        assert!(!disabled.editable() && !disabled.interactive());
    }
}

#[test]
fn accessible_characters_are_graphemes_that_sum_to_the_value() {
    let content = "e\u{301}\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{5e9}";
    let lengths = accessible_characters(content);
    assert_eq!(lengths, [3, 18, 2]);
    assert_eq!(accessible_index(&lengths, 0), 0);
    assert_eq!(accessible_index(&lengths, 3), 1);
    // An offset inside a cluster counts only the wholly preceding characters.
    assert_eq!(accessible_index(&lengths, 10), 1);
    assert_eq!(accessible_index(&lengths, content.len()), 3);
    // A 301-byte cluster (base + 150 combining marks) still sums exactly.
    let long = "a".to_owned() + &"\u{301}".repeat(150);
    let lengths = accessible_characters(&long);
    assert_eq!(
        lengths
            .iter()
            .map(|length| usize::from(*length))
            .sum::<usize>(),
        long.len()
    );
    assert!(lengths.len() > 1);
    assert!(accessible_characters("").is_empty());
}

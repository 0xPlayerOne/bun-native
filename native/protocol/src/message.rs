//! Validation messages that spell protocol limits from their constants, as
//! `&'static str` built at compile time.

/// One piece of a [`limit_message!`]: text, or a limit printed in decimal.
#[doc(hidden)]
pub enum MessagePart {
    Text(&'static str),
    Number(u64),
}

const fn digits(mut number: u64) -> usize {
    let mut count = 1;
    while number >= 10 {
        number /= 10;
        count += 1;
    }
    count
}

#[doc(hidden)]
pub const fn message_len(parts: &[MessagePart]) -> usize {
    let mut length = 0;
    let mut index = 0;
    while index < parts.len() {
        length += match parts[index] {
            MessagePart::Text(text) => text.len(),
            MessagePart::Number(number) => digits(number),
        };
        index += 1;
    }
    length
}

#[doc(hidden)]
pub const fn message_bytes<const N: usize>(parts: &[MessagePart]) -> [u8; N] {
    let mut bytes = [0; N];
    let mut at = 0;
    let mut index = 0;
    while index < parts.len() {
        match parts[index] {
            MessagePart::Text(text) => {
                let text = text.as_bytes();
                let mut byte = 0;
                while byte < text.len() {
                    bytes[at] = text[byte];
                    at += 1;
                    byte += 1;
                }
            }
            MessagePart::Number(mut number) => {
                let count = digits(number);
                let mut digit = count;
                while digit > 0 {
                    digit -= 1;
                    bytes[at + digit] = b'0' + (number % 10) as u8;
                    number /= 10;
                }
                at += count;
            }
        }
        index += 1;
    }
    assert!(at == N);
    bytes
}

/// A `&'static str` of string literals and limits, each limit a constant in
/// braces printed in decimal: `limit_message!("at most ", {MAX_TEXT_BYTES}, " bytes")`.
/// A limit must be a whole, nonnegative number.
#[macro_export]
macro_rules! limit_message {
    ($($part:tt),+ $(,)?) => {{
        const PARTS: &[$crate::MessagePart] = &[$($crate::limit_message!(@part $part)),+];
        const BYTES: [u8; $crate::message_len(PARTS)] = $crate::message_bytes(PARTS);
        const TEXT: &str = match ::core::str::from_utf8(&BYTES) {
            Ok(text) => text,
            Err(_) => panic!("limit messages are UTF-8"),
        };
        TEXT
    }};
    (@part $text:literal) => {
        $crate::MessagePart::Text($text)
    };
    (@part { $limit:expr }) => {
        $crate::MessagePart::Number({
            let limit = $limit;
            assert!(limit as u64 as f64 == limit as f64, "limits are whole numbers");
            limit as u64
        })
    };
}

#[cfg(test)]
mod tests {
    #[test]
    fn limits_print_in_decimal_between_the_text() {
        const LIMIT: usize = 16_384;
        const OFFSET: f64 = 1_000_000.;
        assert_eq!(
            limit_message!("text exceeds ", { LIMIT }, " bytes or contains NUL"),
            "text exceeds 16384 bytes or contains NUL"
        );
        assert_eq!(
            limit_message!("between 0 and ", { OFFSET }),
            "between 0 and 1000000"
        );
        assert_eq!(limit_message!({ 0u8 }, "-", { 9u16 }), "0-9");
        assert_eq!(limit_message!("plain"), "plain");
    }
}

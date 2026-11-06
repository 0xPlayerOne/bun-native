//! Names a Windows grant step may open. The protocol already refuses empty,
//! `.`, `..`, `/` and control-character names; Windows adds names that are
//! not one plain directory entry: `\` (another separator), `:` (a drive or an
//! alternate data stream), the other characters Win32 reserves, trailing dots
//! and spaces (which Win32 strips, so the entry has a second spelling) and DOS
//! device names (`CON`, `NUL`, `COM1`…, with or without an extension), which
//! Win32 paths resolve to devices instead of files.

/// Why a name is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A separator, drive, stream or other character Win32 reserves.
    Character,
    /// A trailing `.` or space that Win32 path parsing strips.
    Trailing,
    /// A DOS device name.
    Device,
}

const DEVICES: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];

fn device(name: &str) -> bool {
    // Win32 ignores everything from the first dot and trailing spaces before it.
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    if DEVICES.contains(&upper.as_str()) {
        return true;
    }
    let mut characters = upper.chars();
    let prefix: String = characters.by_ref().take(3).collect();
    let port = characters.as_str();
    (prefix == "COM" || prefix == "LPT")
        && matches!(
            port,
            "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
}

/// Accepts one protocol-valid name only when Windows resolves it as exactly
/// one ordinary directory entry.
pub fn plain(name: &str) -> Result<(), Refusal> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
    {
        return Err(Refusal::Character);
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(Refusal::Trailing);
    }
    if device(name) {
        return Err(Refusal::Device);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_names_are_accepted() {
        for name in [
            "a.txt",
            "notes",
            ".hidden",
            "con-figure",
            "CONSOLE",
            "COM10",
            "LPT",
            "comma,name",
            "space inside",
            "日本語",
            "PROGRA~1",
            " leading",
        ] {
            assert_eq!(plain(name), Ok(()), "{name}");
        }
    }

    #[test]
    fn separators_streams_and_reserved_characters_are_refused() {
        for name in [
            "a\\b",
            "..\\x",
            "C:",
            "file:stream",
            "file::$DATA",
            "a*",
            "a?",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            "a/b",
            "tab\there",
            "",
            ".",
            "..",
        ] {
            assert_eq!(plain(name), Err(Refusal::Character), "{name:?}");
        }
    }

    #[test]
    fn trailing_dots_and_spaces_are_refused() {
        for name in ["a.", "a ", "...", " ", "a. "] {
            assert_eq!(plain(name), Err(Refusal::Trailing), "{name:?}");
        }
    }

    #[test]
    fn device_names_are_refused_with_any_extension_or_case() {
        for name in [
            "CON",
            "con",
            "Nul",
            "nul.txt",
            "NUL .txt",
            "aux.tar.gz",
            "PRN",
            "COM1",
            "com9.log",
            "LPT0",
            "COM¹",
            "lpt³.x",
            "CONIN$",
            "conout$.txt",
        ] {
            assert_eq!(plain(name), Err(Refusal::Device), "{name:?}");
        }
    }
}

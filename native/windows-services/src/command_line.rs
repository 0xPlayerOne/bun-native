//! The inverse of `CommandLineToArgvW` and the MSVC C runtime's argument
//! parser. Windows passes a child one command-line string; quoting each
//! argument this way lets every conventional program recover the exact
//! argument vector, with no shell involved. (Programs that parse their own
//! command line, such as `cmd.exe /c`, see the string as built here.)

/// The program name and arguments as one command line. The program, as the
/// first argument, is always quoted and may not contain a quote, which no
/// Windows file name can.
pub fn build<A: AsRef<str>>(program: &str, arguments: &[A]) -> Option<String> {
    if program.contains('"') {
        return None;
    }
    let mut line = String::with_capacity(program.len() + 2);
    line.push('"');
    line.push_str(program);
    line.push('"');
    for argument in arguments {
        line.push(' ');
        push(&mut line, argument.as_ref());
    }
    Some(line)
}

fn push(line: &mut String, argument: &str) {
    if !argument.is_empty() && !argument.contains([' ', '\t', '\n', '\u{b}', '"']) {
        line.push_str(argument);
        return;
    }
    line.push('"');
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => {
                backslashes += 1;
                continue;
            }
            // Backslashes before a quote are doubled, and the quote escaped.
            '"' => {
                line.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                line.push('"');
            }
            other => {
                line.extend(std::iter::repeat_n('\\', backslashes));
                line.push(other);
            }
        }
        backslashes = 0;
    }
    // Trailing backslashes precede the closing quote, so they are doubled.
    line.extend(std::iter::repeat_n('\\', backslashes * 2));
    line.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The documented `CommandLineToArgvW` rules (MSVC 2008 and later).
    fn parse(line: &str) -> Vec<String> {
        let characters: Vec<char> = line.chars().collect();
        let mut index = 0;
        let mut arguments = Vec::new();
        // The program name: up to the closing quote, without escapes.
        if characters.first() == Some(&'"') {
            let end = characters[1..].iter().position(|&c| c == '"').unwrap() + 1;
            arguments.push(characters[1..end].iter().collect());
            index = end + 1;
        }
        loop {
            while index < characters.len() && matches!(characters[index], ' ' | '\t') {
                index += 1;
            }
            if index >= characters.len() {
                return arguments;
            }
            let mut argument = String::new();
            let mut quoted = false;
            while index < characters.len() {
                match characters[index] {
                    '\\' => {
                        let run = characters[index..]
                            .iter()
                            .take_while(|&&c| c == '\\')
                            .count();
                        if characters.get(index + run) == Some(&'"') {
                            argument.extend(std::iter::repeat_n('\\', run / 2));
                            if run % 2 == 1 {
                                argument.push('"');
                                index += run + 1;
                            } else {
                                index += run;
                            }
                        } else {
                            argument.extend(std::iter::repeat_n('\\', run));
                            index += run;
                        }
                    }
                    '"' => {
                        if quoted && characters.get(index + 1) == Some(&'"') {
                            argument.push('"');
                            index += 2;
                        } else {
                            quoted = !quoted;
                            index += 1;
                        }
                    }
                    ' ' | '\t' if !quoted => break,
                    other => {
                        argument.push(other);
                        index += 1;
                    }
                }
            }
            arguments.push(argument);
        }
    }

    #[test]
    fn every_argument_round_trips() {
        let arguments = [
            "",
            "plain",
            "two words",
            "tab\there",
            "new\nline",
            "quote\"inside",
            "\"",
            "\"\"",
            "trailing\\",
            "trailing space\\",
            "\\\\server\\share\\",
            "back\\\"slash",
            "back\\\\\"slash",
            "C:\\Program Files\\x",
            "a&b|c>d<e^f%PATH%",
            "-c",
            "printf \"%s\" \"$HOME\"",
            "日本 語",
            "\\",
            " ",
        ];
        let program = "C:\\Windows\\System32\\cmd.exe";
        let line = build(program, &arguments).unwrap();
        let parsed = parse(&line);
        assert_eq!(parsed[0], program);
        assert_eq!(parsed[1..], arguments, "{line}");
    }

    #[test]
    fn known_command_lines() {
        assert_eq!(build("C:\\p.exe", &[] as &[&str]).unwrap(), "\"C:\\p.exe\"");
        assert_eq!(
            build("C:\\p.exe", &["a b", "c", "d\\\"e", "f\\"]).unwrap(),
            "\"C:\\p.exe\" \"a b\" c \"d\\\\\\\"e\" f\\"
        );
        assert_eq!(build("C:\\p.exe", &[""]).unwrap(), "\"C:\\p.exe\" \"\"");
        assert_eq!(build("C:\\a\"b.exe", &["x"]), None);
    }
}

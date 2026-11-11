/**
 * NVDA logs every speech sequence at its input/output level as
 * `Speaking [...]`, the Python repr of the sequence, on the line after the
 * record header. Each phrase is the sequence's strings joined by spaces;
 * commands such as `CancellableSpeech (...)` are not strings and are dropped.
 */
export function nvdaSpeech(log: string): string[] {
  const phrases: string[] = []
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith('Speaking [')) continue
    const parts: string[] = []
    for (const match of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g))
      parts.push((match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1'))
    const phrase = parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ')
    if (phrase) phrases.push(phrase)
  }
  return phrases
}

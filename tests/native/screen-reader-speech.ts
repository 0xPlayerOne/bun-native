/**
 * NVDA logs every speech sequence at its input/output level as
 * `Speaking [...]`, the Python repr of the sequence, on the line after the
 * record header. Each phrase is the sequence's top-level strings joined by
 * spaces. Commands such as `CancellableSpeech (...)` and
 * `LangChangeCommand ('en')` are not strings, so they are dropped together with
 * any string inside their own repr.
 */
export function nvdaSpeech(log: string): string[] {
  const phrases: string[] = []
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith('Speaking [')) continue
    const phrase = topLevelStrings(line.slice('Speaking ['.length))
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ')
    if (phrase) phrases.push(phrase)
  }
  return phrases
}

/** The string literals that are whole elements of a Python list repr. */
function topLevelStrings(body: string): string[] {
  const strings: string[] = []
  let depth = 0
  let element = ''
  let literal: string | null = null
  const finish = () => {
    if (literal !== null && element.trim() === '') strings.push(literal)
    literal = null
    element = ''
  }
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!
    if (char === "'" || char === '"') {
      let value = ''
      let end = index + 1
      for (; end < body.length && body[end] !== char; end++) {
        if (body[end] === '\\' && end + 1 < body.length) end++
        value += body[end]
      }
      if (depth === 0 && literal === null && element.trim() === '') literal = value
      else element += 'x'
      index = end
    } else if (char === '(' || char === '[' || char === '{') {
      depth++
      element += char
    } else if (char === ')' || char === '}' || (char === ']' && depth > 0)) {
      depth--
      element += char
    } else if (char === ']' && depth === 0) {
      finish()
      break
    } else if (char === ',' && depth === 0) {
      finish()
    } else if (char.trim() !== '') {
      element += char
    }
  }
  return strings
}

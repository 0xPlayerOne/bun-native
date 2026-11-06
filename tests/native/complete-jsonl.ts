/**
 * Native evidence is append-only JSONL. Readers can observe the writer during
 * an append, before the final newline has made the record complete. Consume
 * only newline-terminated records; keep strict JSON parsing for every complete
 * line so corrupt evidence still fails the qualification.
 */
export function completeJsonLines(text: string): string[] {
  const end = text.lastIndexOf('\n')
  return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean)
}

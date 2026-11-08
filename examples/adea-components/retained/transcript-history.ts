import type { OpenedMessage } from '../types.ts'

/**
 * The loaded window of one conversation: messages ascending by sequence, and
 * the cursor of the page before the oldest one, while the server says older
 * history exists.
 */
export type TranscriptHistory = Readonly<{
  messages: readonly OpenedMessage[]
  olderBefore?: number | undefined
}>

/** A backward page: ascending messages, `nextBeforeSequence` while older ones exist. */
export type TranscriptPage = Readonly<{
  messages: readonly OpenedMessage[]
  nextBeforeSequence?: number
}>

/**
 * Whether a row can keep showing its earlier copy of a message. A sealed body opens on this device
 * after the page that listed it, so the opened text counts as well as the server's version.
 */
export function sameShownMessage(previous: OpenedMessage, next: OpenedMessage): boolean {
  return (
    previous.version === next.version &&
    previous.updatedAt === next.updatedAt &&
    previous.bodyText === next.bodyText
  )
}

/** Merges by message id (the incoming copy wins), ascending by sequence. */
export function mergeMessages(
  current: readonly OpenedMessage[],
  incoming: readonly OpenedMessage[]
): readonly OpenedMessage[] {
  const merged = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) merged.set(message.id, message)
  return [...merged.values()].toSorted((left, right) => left.sequence - right.sequence)
}

/**
 * Applies the newest page. It extends the loaded window when the two meet; when
 * messages may sit between the newest loaded one and the page (more arrived than
 * one page holds while the window was away), the window restarts at the page so
 * it never shows history with a hole in it.
 */
export function withTailPage(history: TranscriptHistory, page: TranscriptPage): TranscriptHistory {
  const newest = history.messages.at(-1)?.sequence
  if (
    newest === undefined ||
    (page.nextBeforeSequence !== undefined && newest + 1 < page.nextBeforeSequence)
  )
    return { messages: page.messages, olderBefore: page.nextBeforeSequence }
  return {
    messages: mergeMessages(history.messages, page.messages),
    // A tail with nothing before it holds the whole conversation.
    olderBefore: page.nextBeforeSequence === undefined ? undefined : history.olderBefore,
  }
}

/** Applies the page read before `history.olderBefore`. */
export function withOlderPage(history: TranscriptHistory, page: TranscriptPage): TranscriptHistory {
  return {
    messages: mergeMessages(history.messages, page.messages),
    olderBefore: page.nextBeforeSequence,
  }
}

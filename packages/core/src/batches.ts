import type { Limits } from '@bun-native/protocol'
import { NativeCommandError } from '@bun-native/runtime'
import { BATCH_ENVELOPE_BYTES, type Transaction } from './tree.ts'
import { NativeStateError, type NativeBatch } from './types.ts'

/** One caller's batch callback, queued behind the transaction in flight. */
export interface BatchEntry {
  readonly update: (batch: NativeBatch) => unknown
  resolve(value: unknown): void
  reject(error: unknown): void
}

/** The window a group of batches commits to. */
export interface BatchWindow {
  /** A transaction over the committed graph; throws once the window is closed. */
  transaction(): Transaction
  /**
   * Send `transactions`, each continuing the one before it, as one native
   * batch, and commit them in order after its acknowledgement.
   */
  apply(transactions: readonly Transaction[]): Promise<void>
}

/**
 * A callback's outcome. Only one with operations takes part in a native
 * batch; the others settle in their place in the order.
 */
type Member = { entry: BatchEntry; transaction?: Transaction } & (
  | { failed: false; value: unknown }
  | { failed: true; error: unknown }
)

function settle(member: Member): void {
  if (member.failed) member.entry.reject(member.error)
  else member.entry.resolve(member.value)
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Run one callback in its own transaction; a failure is that caller's alone. */
function build(window: BatchWindow, entry: BatchEntry, base: Transaction | undefined): Member {
  let transaction: Transaction | undefined
  try {
    transaction = base ? base.next() : window.transaction()
    const value = entry.update(transaction)
    if (isThenable(value)) {
      // Reject the async contract while consuming a later rejection from
      // the already-started callback. Its escaped transaction is revoked.
      void Promise.resolve(value).catch(() => {})
      throw new NativeStateError('invalid_state', 'Batch callbacks must be synchronous')
    }
    transaction.validate()
    return transaction.operations.length
      ? { entry, transaction, failed: false, value }
      : { entry, failed: false, value }
  } catch (error) {
    return { entry, failed: true, error }
  } finally {
    transaction?.finish()
  }
}

const dependent = () =>
  new NativeStateError(
    'stale_revision',
    'Batch was built on a coalesced batch that the native host rejected'
  )

/**
 * Send one native batch for `frame` and record its callers' outcomes in
 * order. When the host rejects a merged batch, its transactions are retried
 * one at a time so only the first rejected one and those built on it fail.
 * Returns whether every transaction committed.
 */
async function flush(
  window: BatchWindow,
  frame: readonly Member[],
  outcomes: Member[]
): Promise<boolean> {
  const sent = frame.flatMap((member) => (member.transaction ? [member.transaction] : []))
  let failure: { error: unknown } | undefined
  try {
    await window.apply(sent)
  } catch (error) {
    failure = { error }
  }
  if (!failure || sent.length === 1 || !(failure.error instanceof NativeCommandError)) {
    // A callback without operations neither depends on nor changes the batch.
    for (const member of frame)
      outcomes.push(
        failure && member.transaction
          ? { entry: member.entry, failed: true, error: failure.error }
          : member
      )
    return !failure
  }
  let rejected = false
  for (const member of frame) {
    if (!member.transaction) outcomes.push(member)
    else if (rejected) outcomes.push({ entry: member.entry, failed: true, error: dependent() })
    else
      try {
        await window.apply([member.transaction])
        outcomes.push(member)
      } catch (error) {
        rejected = true
        outcomes.push({ entry: member.entry, failed: true, error })
      }
  }
  return !rejected
}

/**
 * Run batch callbacks queued behind the transaction in flight, in order, and
 * send them as few native batches as the negotiated limits allow. Each
 * callback runs in its own transaction over the candidate before it, exactly
 * as if the earlier ones had been acknowledged, so a throwing or invalid
 * callback rejects only its own promise. A transaction joins the open batch
 * only while the batch stays within the operation limit, a conservative
 * frame size bound and the focus and scroll requests already in it;
 * otherwise the open batch is sent first.
 *
 * Callers settle in order, each after the acknowledgement of the batch that
 * carried its operations. The returned function settles the last ones; the
 * queue calls it once it has released the next queued operation.
 */
export async function runBatches(
  window: BatchWindow,
  entries: readonly BatchEntry[],
  limits: Readonly<Limits>
): Promise<() => void> {
  const outcomes: Member[] = []
  const release = () => {
    for (const member of outcomes.splice(0)) settle(member)
  }
  if (entries.length === 1) {
    // Nothing to merge: one transaction is one batch, whatever its size.
    const member = build(window, entries[0]!, undefined)
    if (member.transaction) await flush(window, [member], outcomes)
    else outcomes.push(member)
    return release
  }
  const budget = limits.max_frame_bytes - BATCH_ENVELOPE_BYTES
  let frame: Member[] = []
  let tip: Transaction | undefined
  let operations = 0
  let bytes = 0
  const send = async () => {
    release()
    const committed = await flush(window, frame, outcomes)
    frame = []
    tip = undefined
    operations = 0
    bytes = 0
    return committed
  }
  for (const entry of entries) {
    const member = build(window, entry, tip)
    const transaction = member.transaction
    if (!transaction) {
      ;(frame.length ? frame : outcomes).push(member)
      continue
    }
    const count = transaction.operations.length
    const size = transaction.bytesBound()
    if (
      tip &&
      (operations + count > limits.max_operations ||
        bytes + size > budget ||
        !transaction.keepsPrior())
    ) {
      if (!(await send())) {
        // It read the candidate of a batch that did not commit.
        outcomes.push({ entry, failed: true, error: dependent() })
        continue
      }
      transaction.detach()
    }
    frame.push(member)
    tip = transaction
    operations += count
    bytes += size
    // A transaction that may not fit one frame alone is sent before any other
    // callback builds on it, so its failure is its own.
    if (bytes > budget) await send()
  }
  if (frame.length) await send()
  return release
}

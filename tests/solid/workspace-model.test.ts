import { describe, expect, test } from 'bun:test'
import {
  initialWorkspace,
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MAX_PROMPT_LENGTH,
  REPLY_INTERVAL_MS,
  selectedConversation,
  WorkspaceController,
  type WorkspaceState,
} from '../../examples/solid-workspace/model.ts'

function fixture(changed: (state: WorkspaceState) => void = () => {}) {
  const callbacks: { fire: () => void; cancelled: boolean }[] = []
  const controller = new WorkspaceController(changed, (fire) => {
    const callback = { fire, cancelled: false }
    callbacks.push(callback)
    return () => {
      callback.cancelled = true
    }
  })
  function finish() {
    for (let count = 0; controller.ownership.activeReplies && count < 9; count++)
      callbacks.at(-1)!.fire()
    expect(controller.ownership.activeReplies).toBe(0)
  }
  return { controller, callbacks, finish }
}

describe('local workspace state and async ownership (no native rendering)', () => {
  test('streams deterministic text into one stable message and releases its only timer', () => {
    const { controller, callbacks, finish } = fixture()
    controller.create()
    const firstId = controller.state.nextMessageId
    expect(controller.send('  Review the design  ')).toBe(true)
    expect(controller.send('Concurrent reply')).toBe(false)
    expect(selectedConversation(controller.state).messages.map((message) => message.id)).toEqual([
      firstId,
      firstId + 1,
    ])
    expect(controller.ownership).toMatchObject({ pendingTimers: 1, activeReplies: 1 })
    callbacks[0]!.fire()
    expect(selectedConversation(controller.state).messages.at(-1)?.body).toBe('Local reply: ')
    // A duplicate delivery from an already-consumed timer cannot consume the next chunk.
    callbacks[0]!.fire()
    expect(callbacks).toHaveLength(2)
    finish()
    expect(selectedConversation(controller.state).messages.at(-1)).toEqual({
      id: firstId + 1,
      role: 'assistant',
      body: 'Local reply: “Review the design”. This text arrives in eight bounded updates. No backend was contacted.',
      status: 'complete',
    })
    expect(controller.ownership).toEqual({
      disposed: false,
      pendingTimers: 0,
      activeReplies: 0,
      completedReplies: 1,
      cancelledReplies: 0,
    })
    controller.dispose()
  })

  test('switching preserves drafts and partial text while rejecting old and foreign-session callbacks', () => {
    const { controller, callbacks } = fixture()
    controller.setDraft('Saved draft')
    controller.select(2)
    controller.send('First reply')
    callbacks[0]!.fire()
    const stale = callbacks.at(-1)!
    controller.select(1)
    expect(stale.cancelled).toBe(true)
    expect(selectedConversation(controller.state).draft).toBe('Saved draft')
    expect(controller.state.conversations[1]?.messages.at(-1)).toMatchObject({
      body: 'Local reply: ',
      status: 'cancelled',
    })
    controller.send('Second reply')
    const current = callbacks.at(-1)!
    const before = controller.state
    stale.fire()
    expect(controller.state).toBe(before)
    expect(current.cancelled).toBe(false)
    expect(controller.ownership.pendingTimers).toBe(1)
    current.fire()
    controller.cancel()
    expect(controller.ownership).toMatchObject({
      cancelledReplies: 2,
      activeReplies: 0,
      pendingTimers: 0,
    })
    controller.cancel()
    controller.dispose()
  })

  test('closing and clearing cannot revive removed history or confirm a different conversation', () => {
    const { controller, callbacks } = fixture()
    controller.create()
    const removedId = controller.state.selectedId
    controller.send('Close while pending')
    const removed = callbacks.at(-1)!
    controller.close()
    removed.fire()
    expect(
      controller.state.conversations.some((conversation) => conversation.id === removedId)
    ).toBe(false)
    controller.requestClear()
    controller.select(2)
    controller.confirmClear()
    expect(selectedConversation(controller.state).messages).toHaveLength(2)
    controller.requestClear()
    controller.dismissClear()
    controller.confirmClear()
    expect(selectedConversation(controller.state).messages).toHaveLength(2)
    controller.send('Clear while pending')
    const cleared = callbacks.at(-1)!
    controller.requestClear()
    controller.confirmClear()
    cleared.fire()
    expect(selectedConversation(controller.state).messages).toHaveLength(0)
    expect(controller.ownership).toMatchObject({
      cancelledReplies: 2,
      activeReplies: 0,
      pendingTimers: 0,
    })
    controller.dispose()
  })

  test('conversation and message limits retain a valid selection and reject empty or oversized prompts', () => {
    const { controller, finish } = fixture()
    const before = controller.state
    controller.select(-1)
    controller.select(1)
    expect(controller.state).toBe(before)
    expect(controller.send('   ')).toBe(false)
    expect(controller.send('x'.repeat(MAX_PROMPT_LENGTH + 1))).toBe(false)
    for (let index = 0; index < MAX_CONVERSATIONS; index++) controller.create()
    expect(controller.state.conversations).toHaveLength(MAX_CONVERSATIONS)
    expect(selectedConversation(controller.state).messages).toHaveLength(0)
    expect(controller.send('x'.repeat(MAX_PROMPT_LENGTH))).toBe(true)
    finish()
    while (selectedConversation(controller.state).messages.length < MAX_MESSAGES) {
      expect(controller.send('Another local prompt')).toBe(true)
      finish()
    }
    expect(controller.send('Over the history limit')).toBe(false)
    while (controller.state.conversations.length > 1) controller.close()
    controller.close()
    expect(controller.state.conversations).toHaveLength(1)
    expect(selectedConversation(controller.state).id).toBe(11)
    controller.dispose()
  })

  test('theme and details changes preserve a pending reply; disposal makes every action inert', () => {
    let changes = 0
    const { controller, callbacks } = fixture(() => {
      changes++
    })
    controller.send('Dispose safely')
    const stale = callbacks[0]!
    controller.toggleTheme()
    controller.toggleTheme()
    controller.toggleDetails()
    controller.toggleDetails()
    expect(controller.state.theme).toBe('dark')
    expect(controller.state.details).toBe(true)
    expect(stale.cancelled).toBe(false)
    const published = changes
    controller.dispose()
    expect(stale.cancelled).toBe(true)
    const disposed = controller.state
    for (const operation of [
      () => controller.setDraft('After disposal'),
      () => controller.send('After disposal'),
      () => controller.cancel(),
      () => controller.select(2),
      () => controller.create(),
      () => controller.close(),
      () => controller.toggleTheme(),
      () => controller.toggleDetails(),
      () => controller.requestClear(),
      () => controller.dismissClear(),
      () => controller.confirmClear(),
      () => controller.dispose(),
      () => stale.fire(),
    ])
      operation()
    expect(controller.state).toBe(disposed)
    expect(changes).toBe(published)
    expect(controller.ownership).toEqual({
      disposed: true,
      pendingTimers: 0,
      activeReplies: 0,
      completedReplies: 0,
      cancelledReplies: 1,
    })
    expect(selectedConversation(controller.state).messages.at(-1)?.status).toBe('cancelled')
  })

  test('a reentrant observer can cancel or dispose before the next timer is scheduled', () => {
    const { controller, callbacks } = fixture((state) => {
      if (selectedConversation(state).messages.at(-1)?.body === 'Local reply: ') controller.cancel()
    })
    controller.send('Reentrant cancellation')
    callbacks[0]!.fire()
    expect(callbacks).toHaveLength(1)
    expect(controller.ownership).toMatchObject({ activeReplies: 0, pendingTimers: 0 })
    controller.dispose()
    const disposed = fixture(() => {
      disposed.controller.dispose()
    })
    disposed.controller.send('Disposed by initial publish')
    expect(disposed.callbacks).toHaveLength(0)
    expect(disposed.controller.ownership.disposed).toBe(true)
  })

  test('the real timer is cleared on disposal without any late publication', async () => {
    let changes = 0
    const controller = new WorkspaceController(() => {
      changes++
    })
    controller.send('Real owned timer')
    expect(controller.ownership.pendingTimers).toBe(1)
    controller.dispose()
    await Bun.sleep(REPLY_INTERVAL_MS + 20)
    expect(changes).toBe(1)
    expect(controller.ownership.pendingTimers).toBe(0)
  })

  test('an invalid selection is rejected as an invariant failure', () => {
    expect(() => selectedConversation({ ...initialWorkspace(), selectedId: -1 })).toThrow(
      'selected conversation'
    )
  })
})

export const MAX_CONVERSATIONS = 12
export const MAX_MESSAGES = 24
export const MAX_PROMPT_LENGTH = 240
export const REPLY_INTERVAL_MS = 250

export interface Message {
  readonly id: number
  readonly role: 'user' | 'assistant'
  readonly body: string
  readonly status: 'complete' | 'streaming' | 'cancelled'
}

export interface Conversation {
  readonly id: number
  readonly title: string
  readonly draft: string
  readonly messages: readonly Message[]
}

export interface WorkspaceState {
  readonly conversations: readonly Conversation[]
  readonly selectedId: number
  readonly theme: 'light' | 'dark'
  readonly details: boolean
  readonly clearConfirmation: number | null
  readonly nextConversationId: number
  readonly nextMessageId: number
}

export interface WorkspaceOwnership {
  readonly disposed: boolean
  readonly pendingTimers: number
  readonly activeReplies: number
  readonly completedReplies: number
  readonly cancelledReplies: number
}

/** Schedule one later callback and return its cancellation function. */
export type ReplyScheduler = (callback: () => void) => () => void

const scheduleReply: ReplyScheduler = (callback) => {
  const timer = setTimeout(callback, REPLY_INTERVAL_MS)
  return () => clearTimeout(timer)
}

export function initialWorkspace(): WorkspaceState {
  let nextMessageId = 1
  const topics = [
    'Project brief',
    'Native interactions',
    'Release checklist',
    'Design review',
    'Accessibility notes',
    'Build notes',
    'Research queue',
    'Archive',
  ]
  const notes = [
    [
      'What is this workspace?',
      'A local Solid reference app with native panes and conversation history.',
    ],
    [
      'Where are the replies generated?',
      'Replies are deterministic local text. No server, model, or network is connected.',
    ],
    [
      'Can I switch conversations?',
      'Each conversation keeps its draft and history. Switching cancels any unfinished reply.',
    ],
    [
      'How do I stop a reply?',
      'Use Cancel reply. Partial text stays in the conversation with a Cancelled label.',
    ],
    [
      'Can the terminal run commands?',
      'No. PTY and shell execution are unsupported in this reference workspace.',
    ],
    [
      'What should I try next?',
      'Send a short prompt, change the theme, resize the window, and scroll this history.',
    ],
  ]
  return {
    conversations: topics.map((title, index) => ({
      id: index + 1,
      title,
      draft: '',
      messages: (index === 0 ? notes : notes.slice(0, 1)).flatMap(([question, answer]) => [
        {
          id: nextMessageId++,
          role: 'user' as const,
          body: question!,
          status: 'complete' as const,
        },
        {
          id: nextMessageId++,
          role: 'assistant' as const,
          body: answer!,
          status: 'complete' as const,
        },
      ]),
    })),
    selectedId: 1,
    theme: 'dark',
    details: true,
    clearConfirmation: null,
    nextConversationId: topics.length + 1,
    nextMessageId,
  }
}

export function selectedConversation(state: WorkspaceState): Conversation {
  const selected = state.conversations.find((conversation) => conversation.id === state.selectedId)
  if (!selected) throw new Error('A workspace must retain one selected conversation')
  return selected
}

interface PendingReply {
  conversationId: number
  messageId: number
  chunks: readonly string[]
  index: number
  timer?: { cancel?: () => void }
}

/** Owns the local simulation, not a backend connection or a native capability. */
export class WorkspaceController {
  #state = initialWorkspace()
  #active: PendingReply | undefined
  #disposed = false
  #completed = 0
  #cancelled = 0

  constructor(
    private readonly changed: (state: WorkspaceState) => void,
    private readonly schedule: ReplyScheduler = scheduleReply
  ) {}

  get state(): WorkspaceState {
    return this.#state
  }

  get ownership(): WorkspaceOwnership {
    return {
      disposed: this.#disposed,
      pendingTimers: this.#active?.timer ? 1 : 0,
      activeReplies: this.#active ? 1 : 0,
      completedReplies: this.#completed,
      cancelledReplies: this.#cancelled,
    }
  }

  #publish() {
    if (!this.#disposed) this.changed(this.#state)
  }

  #replace(id: number, change: (conversation: Conversation) => Conversation) {
    this.#state = {
      ...this.#state,
      conversations: this.#state.conversations.map((conversation) =>
        conversation.id === id ? change(conversation) : conversation
      ),
    }
  }

  #cancel() {
    const reply = this.#active
    if (!reply) return
    this.#active = undefined
    reply.timer?.cancel?.()
    delete reply.timer
    this.#cancelled++
    this.#replace(reply.conversationId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.id === reply.messageId ? { ...message, status: 'cancelled' } : message
      ),
    }))
  }

  #next(reply: PendingReply) {
    if (this.#disposed || this.#active !== reply) return
    const timer: NonNullable<PendingReply['timer']> = {}
    reply.timer = timer
    timer.cancel = this.schedule(() => {
      // A cancelled callback can still be queued. Its identity must not release
      // a newer timer or write into a different conversation/reply.
      if (this.#disposed || this.#active !== reply || reply.timer !== timer) return
      delete reply.timer
      reply.index++
      const complete = reply.index === reply.chunks.length
      if (complete) {
        this.#active = undefined
        this.#completed++
      }
      this.#replace(reply.conversationId, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.id === reply.messageId
            ? {
                ...message,
                body: reply.chunks.slice(0, reply.index).join(''),
                status: complete ? 'complete' : 'streaming',
              }
            : message
        ),
      }))
      this.#publish()
      // Observers may synchronously cancel, switch sessions, or dispose.
      this.#next(reply)
    })
  }

  setDraft(value: string) {
    if (this.#disposed) return
    this.#replace(this.#state.selectedId, (conversation) => ({ ...conversation, draft: value }))
    this.#publish()
  }

  send(value: string): boolean {
    const prompt = value.trim()
    const conversation = selectedConversation(this.#state)
    if (
      this.#disposed ||
      this.#active ||
      !prompt ||
      prompt.length > MAX_PROMPT_LENGTH ||
      conversation.messages.length > MAX_MESSAGES - 2
    )
      return false
    const messageId = this.#state.nextMessageId + 1
    const reply: PendingReply = {
      conversationId: conversation.id,
      messageId,
      chunks: [
        'Local reply: ',
        `“${prompt}”. `,
        'This text ',
        'arrives in ',
        'eight bounded ',
        'updates. ',
        'No backend ',
        'was contacted.',
      ],
      index: 0,
    }
    this.#active = reply
    this.#replace(conversation.id, (current) => ({
      ...current,
      draft: '',
      messages: [
        ...current.messages,
        { id: messageId - 1, role: 'user', body: prompt, status: 'complete' },
        { id: messageId, role: 'assistant', body: '', status: 'streaming' },
      ],
    }))
    this.#state = { ...this.#state, nextMessageId: messageId + 1, clearConfirmation: null }
    this.#publish()
    this.#next(reply)
    return true
  }

  cancel() {
    if (this.#disposed || !this.#active) return
    this.#cancel()
    this.#publish()
  }

  select(id: number) {
    if (
      this.#disposed ||
      id === this.#state.selectedId ||
      !this.#state.conversations.some((conversation) => conversation.id === id)
    )
      return
    this.#cancel()
    this.#state = { ...this.#state, selectedId: id, clearConfirmation: null }
    this.#publish()
  }

  create() {
    if (this.#disposed || this.#state.conversations.length >= MAX_CONVERSATIONS) return
    this.#cancel()
    const id = this.#state.nextConversationId
    this.#state = {
      ...this.#state,
      conversations: [
        ...this.#state.conversations,
        { id, title: `Conversation ${id}`, draft: '', messages: [] },
      ],
      selectedId: id,
      nextConversationId: id + 1,
      clearConfirmation: null,
    }
    this.#publish()
  }

  close() {
    if (this.#disposed || this.#state.conversations.length === 1) return
    this.#cancel()
    const conversations = this.#state.conversations.filter(
      (conversation) => conversation.id !== this.#state.selectedId
    )
    this.#state = {
      ...this.#state,
      conversations,
      selectedId: conversations[0]!.id,
      clearConfirmation: null,
    }
    this.#publish()
  }

  toggleTheme() {
    if (this.#disposed) return
    this.#state = { ...this.#state, theme: this.#state.theme === 'dark' ? 'light' : 'dark' }
    this.#publish()
  }

  toggleDetails() {
    if (this.#disposed) return
    this.#state = { ...this.#state, details: !this.#state.details }
    this.#publish()
  }

  requestClear() {
    if (this.#disposed) return
    this.#state = { ...this.#state, clearConfirmation: this.#state.selectedId }
    this.#publish()
  }

  dismissClear() {
    if (this.#disposed) return
    this.#state = { ...this.#state, clearConfirmation: null }
    this.#publish()
  }

  confirmClear() {
    if (this.#disposed || this.#state.clearConfirmation !== this.#state.selectedId) return
    this.#cancel()
    this.#replace(this.#state.selectedId, (conversation) => ({ ...conversation, messages: [] }))
    this.#state = { ...this.#state, clearConfirmation: null }
    this.#publish()
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#cancel()
  }
}

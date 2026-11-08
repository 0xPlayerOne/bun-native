/**
 * The fields of Adea's `OpenedMessage` (`@adea-ai/types`, adea 37dd7406) that
 * the retained transcript code and this view read. Adea's full type also
 * carries channel, workspace, sealed-body, mention and task fields that come
 * from its server; this example has no server, so `sender` is a display name
 * here instead of Adea's `MessageSenderRef`.
 */
export type OpenedMessage = Readonly<{
  id: string
  sequence: number
  version: number
  updatedAt: string
  sender: string
  bodyText?: string
}>

import { z } from 'zod'
import { clientMutationIdSchema, itemCauseSchema, seqSchema } from './api.ts'
import { utf8ByteLength } from './cursor.ts'
import { idSchema, itemSchema } from './entities.ts'

// The change feed (D57, D58): one WebSocket per tab at `GET /v1/workspaces/:workspaceId/feed`,
// and the same events over HTTP at `GET /v1/workspaces/:workspaceId/changes` for agents and
// for catching up. Shapes shared by `apps/api` and `apps/web`.

/** Most bytes (UTF-8) of one client message. Larger ones are refused unparsed (D57). */
export const MAX_CLIENT_MESSAGE_BYTES = 4096
/** Most hubs one socket subscribes to at once. */
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 20
/**
 * The client rule: never have more than this many messages sent since the last message received
 * on the socket. The server closes a socket with `FEED_CLOSE_CODES.policy` (1008) when more than
 * this many of its messages are waiting to be handled, so a client that keeps the rule is never
 * closed for it.
 *
 * `subscribe` is always answered (`changes`, `resync` or `error`); `unsubscribe` never is. With at
 * most `MAX_SUBSCRIPTIONS_PER_SOCKET` subscriptions a client never needs more unsubscribes in a
 * row than that, so the rule only makes it wait for answers, never blocks it for good. Resubscribing
 * every hub after a reconnect fits in one burst.
 */
export const MAX_PENDING_CLIENT_MESSAGES = 32
/** Past this many missed changes the subscriber could see, the server answers `resync` (D58). */
export const MAX_MISSED_CHANGES = 1000
/** Largest `limit` of `GET /changes`. */
export const MAX_CHANGES_LIMIT = 1000
export const DEFAULT_CHANGES_LIMIT = 200

/**
 * One item's change, as it is now (D58): `item` is the item, or `null` when it is gone. Several
 * revisions of one item in a batch collapse to the latest, so `seq` is that revision's.
 * `clientMutationId` is the ID the writer sent with that revision, if any (D59): a client
 * that sees its own ID has already applied the change and only needs the HTTP response.
 * `cause` is that revision's cause (D63), absent when it has none; every reader of the change
 * sees it. An item's full history, with every revision's cause, is
 * `GET /items/:itemId/revisions`.
 */
export const changeSchema = z.strictObject({
  seq: seqSchema,
  hubId: idSchema,
  itemId: idSchema,
  item: itemSchema.nullable(),
  clientMutationId: clientMutationIdSchema.optional(),
  cause: itemCauseSchema.optional(),
})
export type Change = z.infer<typeof changeSchema>

// Client to server.

/**
 * Starts (or restarts) changes for one hub after `after`, the `seq` of the read the client
 * holds (D58). A hub that is missing, hidden, or not an agent's own answers `error`
 * `not_found`, alike in all three cases (D57).
 */
export const subscribeMessageSchema = z.strictObject({
  type: z.literal('subscribe'),
  hubId: idSchema,
  after: seqSchema,
})
/** Stops changes for one hub. Unsubscribing from a hub with no subscription does nothing. */
export const unsubscribeMessageSchema = z.strictObject({
  type: z.literal('unsubscribe'),
  hubId: idSchema,
})
export const feedClientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessageSchema,
  unsubscribeMessageSchema,
])
export type FeedClientMessage = z.infer<typeof feedClientMessageSchema>

// Server to client.

/**
 * Changes after the client's `after`, in `seq` order, for the hubs in `hubIds`. `seq` is the
 * high-water mark for those hubs only: every change in them up to it that the subscriber may see
 * is in this message or an earlier one, even when all of them were hidden and `changes` is
 * empty, so the client's `after` never stalls. A batch cut short by its limit reports its last
 * change's `seq` (D58). A client advances only the hubs in `hubIds`.
 *
 * The server handles a socket's client messages in order. A `subscribe` is answered by a
 * `changes` message for that hub alone (its catch-up from `after`, possibly empty), or by
 * `resync` or `error`, before the hub appears in any later message.
 */
export const changesMessageSchema = z.strictObject({
  type: z.literal('changes'),
  seq: seqSchema,
  hubIds: z.array(idSchema).min(1).max(MAX_SUBSCRIPTIONS_PER_SOCKET),
  changes: z.array(changeSchema),
})
/**
 * The hub's schema or settings changed (folders, attributes, the hub row): reload
 * `GET /hubs/:hubId`, always. Folder and attribute writes don't bump the hub's `version`, so it
 * is informational only: the hub row's version when the event was sent.
 */
export const hubMessageSchema = z.strictObject({
  type: z.literal('hub'),
  hubId: idSchema,
  version: z.int().min(0),
})
/** The caller lost access to the hub (a grant revoked, the hub deleted); the subscription ended. */
export const accessLostMessageSchema = z.strictObject({
  type: z.literal('access_lost'),
  hubId: idSchema,
})
/**
 * More than `MAX_MISSED_CHANGES` changes since `after`: reload what is shown from the hub and
 * subscribe again with the `seq` of those reads (D58). The subscription has ended.
 */
export const resyncMessageSchema = z.strictObject({
  type: z.literal('resync'),
  hubId: idSchema,
})

export const FEED_ERROR_CODES = [
  /** The hub is missing, hidden, or not the agent's own (D57). */
  'not_found',
  /** Not JSON, or not one of the client message shapes. */
  'invalid_message',
  /** Larger than `MAX_CLIENT_MESSAGE_BYTES`. */
  'message_too_large',
  /** A new subscription past `MAX_SUBSCRIPTIONS_PER_SOCKET`. */
  'too_many_subscriptions',
] as const
export type FeedErrorCode = (typeof FEED_ERROR_CODES)[number]

/** A refused client message. `hubId` names the hub when the message named one. */
export const feedErrorMessageSchema = z.strictObject({
  type: z.literal('error'),
  code: z.enum(FEED_ERROR_CODES),
  message: z.string(),
  hubId: idSchema.optional(),
})

export const feedServerMessageSchema = z.discriminatedUnion('type', [
  changesMessageSchema,
  hubMessageSchema,
  accessLostMessageSchema,
  resyncMessageSchema,
  feedErrorMessageSchema,
])
export type FeedServerMessage = z.infer<typeof feedServerMessageSchema>

/**
 * Codes the server closes a feed socket with. Upgrade refusals are plain HTTP errors instead
 * (D57); a browser `WebSocket` sees those only as a failed connection.
 */
export const FEED_CLOSE_CODES = {
  /** The process is shutting down: reconnect with backoff and resume. */
  goingAway: 1001,
  /**
   * Over a cap: sockets per session or agent key (close another tab's socket first), or client
   * messages sent faster than the server answers them (wait for answers before sending more).
   */
  policy: 1008,
  /** A frame over the server's frame cap (64 KiB): a client bug, not worth a retry as is. */
  frameTooLarge: 1009,
  /**
   * The server could not read changes, or the client stopped reading what it was sent: reconnect
   * with backoff and resume from the positions held.
   */
  internal: 1011,
  /**
   * The session, agent key or membership ended (sign-out, password reset, revocation, removal,
   * expiry): sign in again; a reconnect would be refused (401 or 404).
   */
  credentialsEnded: 4401,
} as const
export type FeedCloseCode = (typeof FEED_CLOSE_CODES)[keyof typeof FEED_CLOSE_CODES]

export type ParsedClientMessage =
  | { ok: true; message: FeedClientMessage }
  | { ok: false; code: 'invalid_message' | 'message_too_large'; message: string }

/**
 * Parses one client message: the size cap first, then JSON, then the schema (D57). The server
 * uses it for every frame; the web client can use it to check what it sends.
 */
export function parseFeedClientMessage(text: string): ParsedClientMessage {
  // A UTF-16 length over the cap in bytes is over it in UTF-8 too; skip counting huge frames.
  if (text.length > MAX_CLIENT_MESSAGE_BYTES || utf8ByteLength(text) > MAX_CLIENT_MESSAGE_BYTES) {
    return {
      ok: false,
      code: 'message_too_large',
      message: `Messages are at most ${String(MAX_CLIENT_MESSAGE_BYTES)} bytes`,
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, code: 'invalid_message', message: 'Not JSON' }
  }
  const result = feedClientMessageSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') ?? ''
    return {
      ok: false,
      code: 'invalid_message',
      message: `${path ? `${path}: ` : ''}${issue?.message ?? 'Invalid message'}`,
    }
  }
  return { ok: true, message: result.data }
}

/**
 * Query string of `GET /v1/workspaces/:workspaceId/changes`: changes after `after` in every
 * hub the caller can read, `seq` order, at most `limit` (D57). An agent sees its own hub only.
 */
export const changesQuerySchema = z.strictObject({
  // Digits only: an empty `?after=` is refused rather than read as 0, which would replay
  // the whole history.
  after: z
    .string()
    .regex(/^\d{1,15}$/, 'after must be a sequence number')
    .transform(Number)
    .pipe(seqSchema),
  limit: z.coerce.number().int().min(1).max(MAX_CHANGES_LIMIT).default(DEFAULT_CHANGES_LIMIT),
})
export type ChangesQuery = z.input<typeof changesQuerySchema>

/**
 * The response of `GET /changes`. `seq` is the high-water mark, as in a `changes` message: ask
 * again with `after=seq`. `more` is true when `limit` cut the page short, so the next page
 * already has changes waiting; false means the caller is caught up as of `seq`.
 */
export const changesPageSchema = z.strictObject({
  changes: z.array(changeSchema).max(MAX_CHANGES_LIMIT),
  seq: seqSchema,
  more: z.boolean(),
})
export type ChangesPage = z.infer<typeof changesPageSchema>

import { Prisma } from '../generated/prisma/client';
import type { NotificationType } from '../generated/prisma/enums';

import {
  resolveDisplayName,
  resolveProfilePath,
} from '../users/display-name.util';

/**
 * The read shape for a notification, and the transformation every read applies
 * before it leaves the service.
 *
 * Extracted for the same reason `comments/comment-read.ts` is: more than one
 * route returns a notification, and the authorship/attribution rules are the
 * ones most likely to be got wrong in a second copy.
 */

/**
 * The fields needed to render the actor — the person who did the thing.
 *
 * The same six the comment author summary selects: `username` and
 * `usernameLower` exist only to resolve a display name and a link, and neither
 * derived value can be re-derived correctly by a client.
 */
const notificationActorSelect = {
  id: true,
  name: true,
  imageUrl: true,
  username: true,
  usernameLower: true,
  isProfilePrivate: true,
} as const;

/**
 * Read shape for the API.
 *
 * The actor arrives as a summary, the resource as id-plus-title, the comment as
 * id-plus-body. A client needs the resource's *title* to word the row and the
 * comment's *body* to quote it, but nothing deeper — no tags, no counts, no
 * contributor redaction logic to re-run. The resource title is public by
 * definition, anonymous contribution or not: the recipient is being pointed at
 * a page, not shown a name.
 */
export const notificationInclude = {
  actor: { select: notificationActorSelect },
  resource: { select: { id: true, title: true } },
  comment: { select: { id: true, body: true } },
} as const;

/**
 * Newest first, with `id` as a tiebreaker, paired with
 * `Notification_recipientId_createdAt_id_idx`.
 *
 * `createdAt` is not unique, and a keyset cursor over a non-total order skips
 * or repeats rows.
 */
export const notificationOrderBy = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.NotificationOrderByWithRelationInput[];

/** A notification row as read, before any reshaping. */
export type NotificationWithRelations = Prisma.NotificationGetPayload<{
  include: typeof notificationInclude;
}>;

/** A notification as it is returned. */
export type NotificationResponse = {
  id: string;
  type: NotificationType;
  createdAt: Date;
  /** Null until read. The client words null as unread — there is no boolean. */
  readAt: Date | null;
  /**
   * Who did it. Null when the account is gone — rendered as "Someone", never
   * dropped. Never null for anonymity: comments have no anonymous option.
   */
  actor: {
    id: string;
    name: string | null;
    imageUrl: string | null;
    profilePath: string | null;
  } | null;
  /** Where it happened. Always present: the row cascades with the resource. */
  resource: { id: string; title: string };
  /**
   * What was said. Null when the comment was deleted — rendered as "a comment",
   * never dropped: somebody answering is still news.
   */
  comment: { id: string; body: string } | null;
};

/**
 * Flattens a notification row into the response shape.
 *
 * The actor goes through the same summary as a comment author — resolved `name`
 * and `profilePath`, for the same reason: a client working the link out from
 * `usernameLower` and `isProfilePrivate` would get it wrong somewhere. A null
 * actor or comment is passed through rather than forced, so the client can word
 * the deleted-account and deleted-comment states instead of rendering a bug.
 */
export function toNotificationResponse(
  row: NotificationWithRelations,
): NotificationResponse {
  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt,
    readAt: row.readAt,
    actor: row.actor ? toActorSummary(row.actor) : null,
    resource: { id: row.resource.id, title: row.resource.title },
    comment: row.comment
      ? { id: row.comment.id, body: row.comment.body }
      : null,
  };
}

/**
 * Resolves an actor row to the summary a client gets, or `null` when there is
 * no actor at all.
 *
 * Takes the nullable relation so the deleted-account case is handled where it
 * happens instead of by a throw the caller has to remember to avoid.
 */
function toActorSummary(
  actor: NotificationWithRelations['actor'],
): NonNullable<NotificationResponse['actor']> | null {
  if (!actor) return null;

  const { username, usernameLower, isProfilePrivate, ...summary } = actor;

  return {
    ...summary,
    name: resolveDisplayName({ name: summary.name, username }),
    profilePath: resolveProfilePath({ usernameLower, isProfilePrivate }),
  };
}

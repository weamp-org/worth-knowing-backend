import { Prisma } from '../generated/prisma/client';

import {
  resolveDisplayName,
  resolveProfilePath,
} from '../users/display-name.util';

/**
 * The read shape for a comment, and the transformations every read has to apply
 * before it leaves the service.
 *
 * Extracted from `CommentsService` for the same reason `resources/resource-read.ts`
 * is: the create route and the delete route both need to return a comment, and
 * without this they would each grow their own copy of the flattening. A second copy
 * of the redaction logic is a second chance to get the authorship rules wrong, and
 * the rules here are the ones most likely to be got wrong.
 */

/**
 * The fields needed to render a byline for a comment's author.
 *
 * The same six the contributor summary and the collection owner summary select, and
 * the same reason: `username` and `usernameLower` exist only to resolve a display
 * name and a link, and neither derived value can be re-derived correctly by a client.
 */
const commentAuthorSelect = {
  id: true,
  name: true,
  imageUrl: true,
  // Read only to derive a display name and a link. Neither reaches the response —
  // see {@link toAuthorSummary}.
  username: true,
  usernameLower: true,
  isProfilePrivate: true,
} as const;

/**
 * Read shape for the API.
 *
 * `author` is selected flat and `parent` without its own relations, because a client
 * needs the parent's *text* to render a quote but never needs the parent's author or
 * that parent's own `parentId`. Selecting those would drag a second author summary
 * into every row for no reason — and, worse, would invite a client to recurse into a
 * tree this API deliberately does not have.
 */
export const commentInclude = {
  author: { select: commentAuthorSelect },
  parent: { select: { id: true, body: true } },
} as const;

/**
 * Newest first, with `id` as a tiebreaker, paired with
 * `Comment_resourceId_createdAt_id_idx`.
 *
 * Chronological rather than ranked, and that is the whole reason there are no votes
 * on a comment — see `docs/comments.md`. Reddit defaults to oldest-first because it
 * also has a "best" tab driven by votes; with no votes, chronological is the only
 * honest ordering, and it is the one every other listing in this API uses.
 */
export const commentOrderBy = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.CommentOrderByWithRelationInput[];

/** A comment row as read, before any reshaping. */
export type CommentWithRelations = Prisma.CommentGetPayload<{
  include: typeof commentInclude;
}>;

/** How much of a parent is carried into a reply. See {@link truncateForQuote}. */
export const PARENT_QUOTE_LENGTH = 160;

/** A comment as it is returned. */
export type CommentResponse = {
  id: string;
  resourceId: string;
  body: string;
  createdAt: Date;
  author: {
    id: string;
    name: string | null;
    imageUrl: string | null;
    profilePath: string | null;
  } | null;
  parent: { id: string; body: string } | null;
  isMine: boolean;
};

/**
 * Shortens a parent's body for the quote above a reply.
 *
 * Truncated rather than carried whole, because a 2000-character parent rendered in
 * full inside every reply to it would bury the reply it is supposed to frame. An
 * ellipsis marks the cut so a client can tell it happened.
 *
 * Not applied to the comment's own `body`, which is returned in full — a reader who
 * opens a comment wants all of it.
 */
export function truncateForQuote(body: string): string {
  return body.length <= PARENT_QUOTE_LENGTH
    ? body
    : `${body.slice(0, PARENT_QUOTE_LENGTH).trimEnd()}…`;
}

/**
 * Flattens a comment row into the response shape.
 *
 * Three things happen here, and all three are rules a client must not re-derive:
 *
 * 1. **The author's derived fields are replaced** with a resolved `name` and
 *    `profilePath`, for the same reason `withProfilePath` does it on a resource. A
 *    client that worked the link out from `usernameLower` and `isProfilePrivate`
 *    would get it wrong somewhere, and a wrong link points at a 404.
 * 2. **`isMine` is computed from the raw `authorId`**, which the response no longer
 *    carries. Once the author has been reshaped into a summary there is nothing left
 *    for a client to compare against the session, so the server decides — the same
 *    split `isOwner` and `isSaved` already use.
 * 3. **The parent's body is truncated** for the quote.
 *
 * A null author is passed through rather than forced: it means the account was
 * deleted, which is a different state from a comment that was never attributable,
 * and a client words the two differently. The same reasoning as `withProfilePath`
 * applies — re-asserting it would make a row that merely lacked the key come back
 * looking like a redacted one.
 */
export function toCommentResponse(
  comment: CommentWithRelations,
  viewerId?: string,
): CommentResponse {
  return {
    id: comment.id,
    resourceId: comment.resourceId,
    body: comment.body,
    createdAt: comment.createdAt,
    author: toAuthorSummary(comment.author),
    parent: comment.parent
      ? { id: comment.parent.id, body: truncateForQuote(comment.parent.body) }
      : null,
    isMine: comment.authorId !== null && comment.authorId === viewerId,
  };
}

/**
 * Resolves an author row to the summary a client gets, or `null` when there is no
 * author at all.
 *
 * Takes the nullable relation rather than a narrowed one so the null case is handled
 * where it happens instead of by a throw the caller has to remember to avoid.
 */
function toAuthorSummary(
  author: CommentWithRelations['author'],
): NonNullable<CommentResponse['author']> | null {
  if (!author) return null;

  const { username, usernameLower, isProfilePrivate, ...summary } = author;

  return {
    ...summary,
    name: resolveDisplayName({ name: summary.name, username }),
    profilePath: resolveProfilePath({ usernameLower, isProfilePrivate }),
  };
}

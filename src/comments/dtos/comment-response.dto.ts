/**
 * The author of a comment.
 *
 * Narrower than `ContributorSummaryDto`, and deliberately so. There are no
 * anonymity semantics on a comment — a comment is always attributed while its author
 * exists — so there is nothing to withhold and no `isAnonymous` to disambiguate.
 *
 * `id` **is** present here, unlike on a collection's owner summary, and for the same
 * reason the contributor summary on a resource keeps it: it is how the author
 * compares against the session to decide whether to offer delete.
 */
export class CommentAuthorDto {
  /** The Clerk user ID
   * @example 'user_2abc'
   */
  id: string;

  /** The Clerk name, or failing that the handle they claimed here. Never a placeholder.
   * @example 'Ada Lovelace'
   */
  name: string | null;

  imageUrl: string | null;

  /** Where to link this name, resolved by the server, or null when there is nowhere to go.
   * @example '/u/adal'
   */
  profilePath: string | null;
}

/**
 * The comment a reply is answering.
 *
 * A summary rather than the full comment: only enough of the parent to render a
 * quote, and never its own `parentId`, so a client cannot recurse into a tree this
 * API deliberately does not have.
 *
 * Null in two cases, which are different states and are worded differently by the
 * client: `parentId` was null to begin with, or the parent has been deleted and
 * `SetNull` cleared the reference.
 */
export class CommentParentDto {
  id: string;

  /**
   * The parent's text, truncated for the quote.
   *
   * Truncated rather than complete because a 2000-character parent rendered in full
   * inside every reply to it would bury the reply. The full text is still reachable
   * on its own comment.
   * @example 'Chapter 14 is the one that made the whole argument…'
   */
  body: string;
}

/** One comment, as returned by every route here. */
export class CommentResponseDto {
  id: string;

  /**
   * The resource this is on.
   *
   * Redundant with the path on the nested routes, and present because a comment is
   * also returned by nothing else yet — but a client storing a comment should not
   * have to remember which page it came from.
   * @example 'ckq8f2a1b0000abcdefghijkl'
   */
  resourceId: string;

  /**
   * What they said.
   *
   * Stored trimmed, and never blank — the create route rejects a whitespace-only
   * body rather than storing a comment that renders as nothing.
   */
  body: string;

  createdAt: Date;

  /**
   * Who said it.
   *
   * Null only when the author's account has been deleted. A comment outlives its
   * author (`Comment.authorId` is nullable and sets null), so the text stays and
   * renders attributed to nobody — a client should word that as removed, not as
   * anonymous, because the two mean different things here.
   */
  author: CommentAuthorDto | null;

  /** The comment this replies to, or null if it is a top-level comment. */
  parent: CommentParentDto | null;

  /**
   * Whether the signed-in caller wrote this comment.
   *
   * Decided by the server, because the response deliberately does not expose the
   * raw author id once the author has been reshaped into a summary. Always true on
   * a comment the caller just created, and false for a signed-out read.
   */
  isMine: boolean;
}

/** One page of `GET /api/v1/resources/:resourceId/comments`. */
export class PaginatedCommentsResponseDto {
  items: CommentResponseDto[];

  /** Pass back as `?cursor=` to get the next page. `null` on the last page.
   * @example 'Y2txOGYyYTFiMDAw'
   */
  nextCursor: string | null;
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/enums';
import {
  decodeCursor,
  decodeReportCursor,
  encodeCursor,
  encodeReportCursor,
  isCursorNotFound,
} from '../pagination/cursor.util';
import { CreateCommentDto } from './dtos/create-comment.dto';
import { ReportCommentDto } from './dtos/report-comment.dto';
import { DEFAULT_PAGE_SIZE } from './dtos/list-comments-query.dto';
import {
  commentInclude,
  commentOrderBy,
  commentReportOrderBy,
  reportInclude,
  toCommentReportResponse,
  toCommentResponse,
  type CommentReportWithComment,
  type CommentWithRelations,
} from './comment-read';

/**
 * Remarks on a resource.
 *
 * One flat, chronological list per resource, with replies stored flat and rendered
 * as a quote above the reply rather than as a tree. The design decisions — why there
 * is no like, why no reply tree, and why a comment outlives its author — are written
 * up in `docs/comments.md` and, where they are enforced, on {@link resolveParentId}.
 */

@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The comments on a resource, newest first, keyset-paginated.
   *
   * Public, like the resource itself and unlike a saved list. Discussion is part of
   * the public surface of a resource, and a page that renders the thread has already
   * decided to show it — the alternative is a comment count on a public response
   * with nothing behind it for a signed-out reader.
   *
   * Ordered chronologically because there are no votes to rank by. See
   * `commentOrderBy` and `docs/comments.md`.
   */
  async findForResource(
    resourceId: string,
    limit?: number,
    cursor?: string,
    viewerId?: string,
  ) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    // Checked before the query so a typo'd resource id is a 404 naming the problem
    // rather than an empty thread, which reads as "nobody has commented" and is a
    // different claim. One extra read, on a page the client has already fetched the
    // resource from.
    await this.assertResourceExists(resourceId);

    let rows: CommentWithRelations[];

    try {
      rows = await this.prisma.comment.findMany({
        where: { resourceId },
        orderBy: commentOrderBy,
        take: take + 1,
        ...(cursor
          ? {
              // The plain primary key, unlike `SavedResource`'s composite. `id` is
              // unique on its own and `resourceId` is already in the path, so there
              // is nothing to reconstruct.
              cursor: { id: decodeCursor(cursor) },
              skip: 1,
            }
          : undefined),
        include: commentInclude,
      });
    } catch (error) {
      // A comment deleted between pages. Same reasoning as the resource feed: an
      // empty page is right, and a 400 would be noise.
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items: items.map((row) => toCommentResponse(row, viewerId)),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  /**
   * Posts a comment on a resource.
   *
   * Any resource on the site, including one shared anonymously. Discussing an
   * anonymous contribution does not un-withhold the contributor: `resourceId` is the
   * only thing that ties a comment to a resource, and the byline redaction happens
   * on the resource read, not here.
   *
   * There is no anonymity option for a comment, unlike a resource. A resource is
   * link-plus-reason, so withholding the author still leaves the contribution
   * legible; a comment is a position taken in public conversation, and an anonymous
   * one is close to a burner account — with no rate limiting tight enough and no
   * reputation yet to make that safe.
   */
  async create(resourceId: string, authorId: string, dto: CreateCommentDto) {
    const body = dto.body.trim();

    // A comment that renders as nothing is worse than none: it takes a row in the
    // thread and a count in `commentCount` while giving a reader nothing to react to.
    // `@MinLength(1)` on the DTO rejects `""` but not `"   "`.
    if (body.length === 0) {
      throw new BadRequestException('Comment cannot be empty');
    }

    // Same reason as `SavedService.save`: checked before the write so a typo'd id is
    // a 404 naming the problem rather than a foreign-key violation surfacing as a
    // 500. The FK still enforces it.
    await this.assertResourceExists(resourceId);

    const parentId = await this.resolveParentId(resourceId, dto.parentId);

    const comment = await this.prisma.comment.create({
      data: { resourceId, authorId, body, parentId },
      include: commentInclude,
    });

    return toCommentResponse(comment, authorId);
  }

  /**
   * Removes a comment.
   *
   * Hard, and the replies survive it: `parentId` sets null, so a reply to a deleted
   * comment stays in the thread with its quote gone rather than being cascaded away
   * with it. Deleting somebody else's words because the thing they were answering
   * was removed would be the wrong default — the comment belongs to its author, not
   * to its parent.
   *
   * 204, not 200 with a body. Nothing is left to describe: the row is gone, and
   * returning an emptied comment would invite a client to render "this comment was
   * deleted" from a body that says it has no text.
   */
  /**
   * Flags a comment for a moderator.
   *
   * What a dislike would have been. There is no ranking on this site for a vote to
   * act on, so a downvote had no mechanical function and would only have punished
   * people for sharing what they found worth knowing — the job it genuinely does,
   * putting something in front of a person who can remove it, is this.
   *
   * **Idempotent**, and explicitly so, for the same reason save is: the primary key
   * prevents a duplicate and `skipDuplicates` is race-safe in a way a read-then-write
   * is not. A `409` would punish somebody for a double-click when the state they asked
   * for already holds. The second reason it matters is that one account cannot pad a
   * comment's report count to make it look worse than it is.
   *
   * Reporting your own comment is refused. Not as a punishment — there is nothing to
   * gain by it — but because a queue containing reports an author filed on
   * themselves is a queue a moderator has to read past.
   *
   * The resource is scoped for the same reason the delete is: a report filed through
   * the wrong resource's path would point a moderator at a thread the reporter never
   * saw.
   *
   * `204`, like the delete. There is nothing to render: a reported comment looks
   * exactly as it did before, which is the point — the report is invisible to
   * everyone but a moderator.
   */
  async report(
    resourceId: string,
    commentId: string,
    reporterId: string,
    dto: ReportCommentDto,
  ): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId, resourceId },
      select: { id: true, authorId: true },
    });

    // Same 404 as the delete, so the report route cannot be used to probe for comment
    // ids on other resources either.
    if (!comment) {
      throw new NotFoundException(
        `Comment ${commentId} not found on resource ${resourceId}`,
      );
    }

    if (comment.authorId === reporterId) {
      throw new BadRequestException('You cannot report your own comment');
    }

    await this.prisma.commentReport.createMany({
      data: {
        reporterId,
        commentId,
        reason: dto.reason,
        ...(dto.detail?.trim() ? { detail: dto.detail.trim() } : {}),
      },
      skipDuplicates: true,
    });

    // A repeat report from the same person after a dismissal. The insert above is a
    // no-op in that case — the row exists and the composite primary key stops a second
    // one — so without this the reporter is silently ignored while the endpoint
    // answers 204. Reporting something again is new information: the thing they
    // flagged is still there.
    //
    // The update is unconditional rather than conditional on whether the insert
    // landed, because "did it insert?" is exactly the question `skipDuplicates` was
    // asked not to answer, and a `dismissedAt: { not: null }` guard means the second
    // write costs nothing when there was nothing to reopen.
    await this.reopenDismissedForReporter(commentId, reporterId);
  }

  /**
   * The report queue. Admin only, enforced by `@Roles` on the route.
   *
   * Newest first, paged over `CommentReport` rather than `Comment`, because the order
   * here is *when somebody flagged it* — the same reasoning as `SavedService.findMine`
   * and for the same reason: a two-year-old comment reported yesterday is the newest
   * thing a moderator has to look at, and ordering by the comment's own `createdAt`
   * would bury it.
   *
   * One row per report rather than per comment, so the ordering is over a plain
   * column rather than an aggregate that changes while somebody is paging. See
   * `CommentReportDto` for the argument in full.
   */
  async listReports(limit?: number, cursor?: string) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    // Decoded outside the query so the two halves can be named for what they are here.
    // `decodeReportCursor` speaks in `targetId` because the shape is shared with the
    // resource queue; this one points at a comment.
    const position = cursor ? decodeReportCursor(cursor) : null;

    let rows: CommentReportWithComment[];

    try {
      rows = await this.prisma.commentReport.findMany({
        orderBy: commentReportOrderBy,
        take: take + 1,
        // Dismissed reports are invisible, not shown-and-greyed. A moderator who has
        // already decided to keep a comment should not have to look at it again on
        // every pass, and a greyed row in a queue is a row somebody has to reason
        // about to know it can be skipped.
        where: { dismissedAt: null },
        ...(position
          ? {
              cursor: {
                reporterId_commentId: {
                  reporterId: position.reporterId,
                  commentId: position.targetId,
                },
              },
              skip: 1,
            }
          : undefined),
        include: reportInclude,
      });
    } catch (error) {
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items: items.map((row) => toCommentReportResponse(row)),
      nextCursor:
        hasMore && last
          ? encodeReportCursor(last.commentId, last.reporterId)
          : null,
    };
  }

  /**
   * Marks every report on a comment as dealt with, without touching the comment.
   *
   * "I looked at this and it stays" — which is not the same as removing it, and
   * without this a moderator has no way to say so. A queue a moderator cannot clear
   * is a queue they stop trusting: either it grows forever or they learn to ignore
   * it, and both make the *next* real report less likely to be caught.
   *
   * **Every report for the comment at once**, because a comment five people reported
   * is five rows and dismissing one would leave four still queued — which is to say
   * the queue could never be worked through. That is the whole reason this exists, so
   * a per-report version would have missed the point.
   *
   * Idempotent, and `204` either way. Dismissal is write-once in practice, but two
   * moderators reaching for the same row at the same time is normal and neither
   * should see an error.
   *
   * Deliberately **not** a delete. The comment stays, the report rows stay, and the
   * action is a column becoming non-null — so un-dismissing is `dismissedAt = null`
   * rather than an insert to undo.
   *
   * A report filed *after* a dismissal is a new row from a new reporter and comes
   * back on its own, because it is new information rather than a re-run of a decision
   * somebody already made.
   *
   * Takes no actor id: `dismissedAt` deliberately records *when* and not *who*, so
   * there is nothing here to do with the session. See `CommentReport.dismissedAt`.
   */
  /**
   * Reopens a dismissed comment's reports **for one reporter**, because that person
   * reported it again.
   *
   * This exists because dismissal is per `(target, reporter)` row, and the composite
   * primary key makes a repeat report from the *same* person a silent no-op: the row
   * already exists, `createMany({ skipDuplicates: true })` inserts nothing, and the
   * stale row keeps `dismissedAt` set. The result is that a reader who reports
   * something, sees a moderator keep it, and reports it again is **silently ignored** —
   * the endpoint answers `204` and the row never reappears in the queue.
   *
   * That was in the first version as a stated feature, and it was wrong. It was
   * reasoned about from the *new reporter* case and never checked against the repeat
   * one, and the asymmetry is invisible unless you go looking: a different person
   * reporting after a dismissal creates a new row and works fine.
   *
   * Called from {@link report}, which is the only place a repeat report can arrive.
   *
   * **`createdAt` is refreshed as well as `dismissedAt`, and that is load-bearing.**
   * The queue orders by `createdAt DESC`, so reopening a row while leaving its
   * original date puts a report that arrived *right now* at the bottom of the queue,
   * under everything filed since. A moderator working top-down would never reach it,
   * which is the original bug in a quieter form — reported, and never seen.
   *
   * That trades away the first-report date, deliberately. Both queues order by *when
   * somebody last said this was worth a look*, not by when it first was, and the
   * original date is the one nobody acting on a queue needs.
   */
  private async reopenDismissedForReporter(
    commentId: string,
    reporterId: string,
  ): Promise<void> {
    await this.prisma.commentReport.updateMany({
      where: { commentId, reporterId, dismissedAt: { not: null } },
      data: { dismissedAt: null, createdAt: new Date() },
    });
  }

  async dismiss(commentId: string): Promise<void> {
    await this.prisma.commentReport.updateMany({
      where: { commentId, dismissedAt: null },
      data: { dismissedAt: new Date() },
    });
  }

  /**
   * Puts a dismissed comment's reports back in the queue.
   *
   * The inverse of {@link dismiss}, and the reason dismissal is safe to offer without
   * a confirmation: "reversible in the database" is not "reversible for you", so
   * without this a mis-click would be permanent in practice.
   *
   * Offered by the client as an **Undo on the toast**, not as a dialog asking first.
   * A dialog costs every moderator an extra click on the *safe* action to guard
   * against one rare mistake, and a dialog on every moderation action is how people
   * learn to click through them — including the delete one, which is the only one
   * that genuinely needs reading.
   *
   * Only rows a dismissal actually closed are reopened. A report filed after the
   * dismissal is already `dismissedAt: null` and already in the queue, so this leaves
   * it exactly where it is rather than disturbing a report that was never resolved.
   *
   * Idempotent, and `204` either way, for the same reason as the dismissal.
   */
  async undismiss(commentId: string): Promise<void> {
    await this.prisma.commentReport.updateMany({
      where: { commentId, dismissedAt: { not: null } },
      data: { dismissedAt: null },
    });
  }

  async remove(
    resourceId: string,
    commentId: string,
    actorId: string,
  ): Promise<void> {
    await this.assertCanModify(resourceId, commentId, actorId);

    await this.prisma.comment.delete({ where: { id: commentId } });
  }

  /**
   * Whether the actor may remove the comment, and throws if not.
   *
   * The author, or any admin — the same rule `ResourcesService` applies to a
   * contribution and `CollectionsService` to a collection, and for the same reason: a
   * comment is public content, so the product asks for moderation that does not
   * depend on the author being reachable.
   *
   * In the service rather than behind `@Roles` because `RolesGuard` short-circuits on
   * `if (!requiredRoles) return true`, so a route that must accept *either* an author
   * or an admin cannot be expressed with that decorator and nothing would ever ask
   * what role the caller has.
   *
   * Scoped to the resource in the same read, so a comment id belonging to a different
   * resource is a 404 rather than a successful delete of somebody else's thread. The
   * scope is applied *before* the role check, which is what keeps a stranger's probe
   * from distinguishing "no such comment" from "not yours": both are the same 404,
   * because a non-admin only ever reaches the 403 on a comment that is theirs to fail
   * on.
   */
  private async assertCanModify(
    resourceId: string,
    commentId: string,
    actorId: string,
  ) {
    const comment = await this.prisma.comment.findUnique({
      // `id` alone is unique, so the extra `resourceId` is an AND filter rather than
      // a second lookup — one read answers both "is this on that resource" and "who
      // wrote it".
      where: { id: commentId, resourceId },
      select: { authorId: true },
    });

    if (!comment) {
      throw new NotFoundException(
        `Comment ${commentId} not found on resource ${resourceId}`,
      );
    }

    if (comment.authorId === actorId) return;

    // Not reachable for a comment with no author: `authorId` is null only once the
    // account has been deleted, and a deleted Clerk user cannot hold a session. The
    // role lookup below is what answers, and it will not find them.
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true },
    });

    if (actor?.role !== UserRole.ADMIN) {
      throw new ForbiddenException('You can only remove your own comments');
    }
  }

  /**
   * The id to store as a comment's parent, or `null`.
   *
   * Four things happen here, and each answers a question a naive `parentId: dto.parentId`
   * would get wrong:
   *
   * 1. **The parent has to be on this resource.** A reply to a comment on a
   *    different page would render on the wrong thread, so it is a 404 rather than a
   *    silently misplaced comment.
   * 2. **The parent has to exist at all.** Also a 404, and deliberately not the same
   *    message — a client that got this wrong should not learn whether an unrelated
   *    comment id exists.
   * 3. **Depth is capped at one.** A reply to a reply is re-pointed at the
   *    grandparent, which is the only place the one-level rule is enforced.
   * 4. **A comment may not reply to itself**, which is the degenerate case of (3): a
   *    row whose parent is itself would have no top of the chain for the renderer to
   *    stop at. The id does not exist yet on a create, so this is a property of the
   *    request rather than of the data — but a `parentId` equal to the comment being
   *    created is meaningless, and treating it as a top-level comment is the
   *    forgiving answer.
   */
  private async resolveParentId(
    resourceId: string,
    parentId?: string,
  ): Promise<string | null> {
    if (!parentId) return null;

    const parent = await this.prisma.comment.findUnique({
      where: { id: parentId },
      select: { id: true, resourceId: true, parentId: true },
    });

    if (!parent || parent.resourceId !== resourceId) {
      throw new NotFoundException(
        `Comment ${parentId} not found on this resource`,
      );
    }

    // Already a reply, so re-point at whatever *it* was answering. Depth one is
    // therefore preserved whatever nesting the client sends.
    //
    // `?? parent.id` rather than `parent.parentId` alone: a direct reply to a
    // top-level comment must point at that comment, and its `parentId` is null. Only
    // a reply *to a reply* has a grandparent to defer to.
    return parent.parentId ?? parent.id;
  }

  /**
   * That the resource exists, so a bad id is a 404 rather than an empty thread or a
   * foreign-key violation surfacing as a 500. The FK still enforces it; this just
   * makes the error legible.
   */
  private async assertResourceExists(resourceId: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      select: { id: true },
    });

    if (!resource) {
      throw new NotFoundException(`Resource ${resourceId} not found`);
    }
  }
}

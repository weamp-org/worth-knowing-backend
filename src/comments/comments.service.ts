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
  encodeCursor,
  isCursorNotFound,
} from '../pagination/cursor.util';
import { CreateCommentDto } from './dtos/create-comment.dto';
import { DEFAULT_PAGE_SIZE } from './dtos/list-comments-query.dto';
import {
  commentInclude,
  commentOrderBy,
  toCommentResponse,
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

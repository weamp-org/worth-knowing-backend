import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType } from '../generated/prisma/enums';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from './push.service';
import {
  decodeCursor,
  encodeCursor,
  isCursorNotFound,
} from '../pagination/cursor.util';
import {
  notificationInclude,
  notificationOrderBy,
  toNotificationResponse,
  type NotificationWithRelations,
} from './notification-read';
import { DEFAULT_PAGE_SIZE } from './dtos/list-notifications-query.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /**
   * The caller's inbox, newest first, keyset-paginated.
   *
   * Paged over `Notification` directly: the order is when things *happened*,
   * and the row already carries its own timestamp, so there is nothing to join
   * an ordering onto — unlike a saved list, which orders by a different table's
   * clock.
   */
  async findMine(userId: string, limit?: number, cursor?: string) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    let rows: NotificationWithRelations[];

    try {
      rows = await this.prisma.notification.findMany({
        where: { recipientId: userId },
        orderBy: notificationOrderBy,
        take: take + 1,
        ...(cursor
          ? {
              // The plain primary key: `id` is unique on its own and
              // `recipientId` is already in the filter, so there is nothing to
              // reconstruct — the same shape as the comment thread's cursor.
              cursor: { id: decodeCursor(cursor) },
              skip: 1,
            }
          : undefined),
        include: notificationInclude,
      });
    } catch (error) {
      // A notification deleted between pages (its resource was removed, which
      // cascades). Same reasoning as every other list here: an empty page is
      // right, a 400 would be noise.
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items: items.map(toNotificationResponse),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  /**
   * How many of the caller's notifications are unread.
   *
   * Separate from the list because the header bell polls this and nothing else:
   * refetching a page of rows every 30 seconds to read a number off it would be
   * the list endpoint doing a counter's job.
   */
  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientId: userId, readAt: null },
    });
  }

  /**
   * Marks one notification read and returns it.
   *
   * Scoped to the caller in the write itself: a row that is not theirs matches
   * nothing and 404s, which leaks neither its existence nor its content. A row
   * already read is rewritten to a fresh timestamp rather than rejected —
   * "read" is already the state the caller asked for.
   */
  async markRead(userId: string, id: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { id, recipientId: userId },
      data: { readAt: new Date() },
    });

    if (updated.count === 0) {
      throw new NotFoundException(`Notification ${id} not found`);
    }

    const row = await this.prisma.notification.findUnique({
      where: { id },
      include: notificationInclude,
    });

    // The row matched an `updateMany` a moment ago, so a null here is a race —
    // its resource was deleted between the two statements — and 404 is honest.
    if (!row) {
      throw new NotFoundException(`Notification ${id} not found`);
    }

    return toNotificationResponse(row);
  }

  /**
   * Marks the whole inbox read.
   *
   * One `updateMany`, which is what `readAt`-as-timestamp buys over a boolean:
   * no read-then-write, no per-row round trip. Returns the count so the bell
   * can settle without refetching.
   */
  async markAllRead(userId: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });

    return { updated: updated.count };
  }

  /**
   * Files the notification a new comment earns, if it earns one.
   *
   * A reply notifies the author of the comment it answers; a top-level comment
   * notifies the resource's contributor. Two things earn nothing: a comment by
   * the recipient themselves, and a comment whose recipient is gone (a deleted
   * account leaves a null author or contributor, and there is nobody to tell).
   *
   * Called from `CommentsService.create`, *after* the comment is stored. A
   * failure here must never fail the comment — the remark is the contribution
   * and the notification is its echo — so this never throws.
   */
  async notifyForComment(args: {
    resourceId: string;
    authorId: string;
    /** The resolved parent, already flattened by `resolveParentId`. */
    parentId: string | null;
    commentId: string;
  }): Promise<void> {
    try {
      let recipientId: string | null;
      let type: NotificationType;

      if (args.parentId) {
        const parent = await this.prisma.comment.findUnique({
          where: { id: args.parentId },
          select: { authorId: true },
        });
        recipientId = parent?.authorId ?? null;
        type = NotificationType.REPLY_TO_COMMENT;
      } else {
        const resource = await this.prisma.resource.findUnique({
          where: { id: args.resourceId },
          select: { contributorId: true },
        });
        recipientId = resource?.contributorId ?? null;
        type = NotificationType.COMMENT_ON_RESOURCE;
      }

      if (!recipientId || recipientId === args.authorId) return;

      const notification = await this.prisma.notification.create({
        data: {
          type,
          recipientId,
          actorId: args.authorId,
          resourceId: args.resourceId,
          commentId: args.commentId,
        },
      });

      // After the row, never instead of it: push delivers the inbox, and a
      // delivery failure must not un-file what was earned. Best-effort inside
      // best-effort — `sendForNotification` never throws either.
      await this.push.sendForNotification(notification.id);
    } catch (error) {
      // Swallowed, but not silently: the comment this was filed for already
      // succeeded, so failing the request over its echo would be wrong — while
      // saying nothing would make a broken inbox invisible. A warning keeps
      // both truths.
      this.logger.warn(
        `Notification fan-out failed for comment ${args.commentId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

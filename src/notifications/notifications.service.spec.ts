import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType } from '../generated/prisma/enums';

import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';

const USER = 'user_1';
const OTHER = 'user_2';

/**
 * A partial matcher for the `data` a write was called with.
 *
 * `expect.objectContaining` returns `any`, and the lint rules here reject
 * unsafe assignment off one. This narrows it once so each assertion below
 * reads as a plain call. `expect.any` needs its own `as unknown` for the same
 * reason — see the `markRead` assertions.
 */
function dataContaining(expected: Record<string, unknown>) {
  return expect.objectContaining(expected) as unknown as object;
}

/** A notification row shaped like the `notificationInclude` read. */
function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif_1',
    type: NotificationType.COMMENT_ON_RESOURCE,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    readAt: null,
    recipientId: USER,
    actorId: OTHER,
    actor: {
      id: OTHER,
      name: 'Grace Hopper',
      imageUrl: null,
      username: 'grace',
      usernameLower: 'grace',
      isProfilePrivate: false,
    },
    resourceId: 'res_1',
    resource: { id: 'res_1', title: 'Sapiens' },
    commentId: 'cmt_1',
    comment: { id: 'cmt_1', body: 'Worth it.' },
    ...overrides,
  };
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let push: { sendForNotification: jest.Mock };
  let prisma: {
    notification: {
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    comment: { findUnique: jest.Mock };
    resource: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: PushService,
          useValue: { sendForNotification: jest.fn() },
        },
        {
          provide: PrismaService,
          useValue: {
            notification: {
              findMany: jest.fn().mockResolvedValue([]),
              count: jest.fn().mockResolvedValue(0),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
              findUnique: jest.fn().mockResolvedValue(notificationRow()),
              create: jest.fn().mockResolvedValue(notificationRow()),
            },
            comment: {
              findUnique: jest.fn().mockResolvedValue({ authorId: USER }),
            },
            resource: {
              findUnique: jest.fn().mockResolvedValue({ contributorId: USER }),
            },
          },
        },
      ],
    }).compile();

    service = module.get(NotificationsService);
    prisma = module.get(PrismaService);
    push = module.get(PushService);
  });

  describe('findMine', () => {
    it('returns the newest page scoped to the caller', async () => {
      prisma.notification.findMany.mockResolvedValue([notificationRow()]);

      const page = await service.findMine(USER);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { recipientId: USER } }),
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0].resource.title).toBe('Sapiens');
      expect(page.nextCursor).toBeNull();
    });

    it('carries a cursor when there is another page', async () => {
      const rows = [
        notificationRow({ id: 'n1' }),
        notificationRow({ id: 'n2' }),
      ];
      prisma.notification.findMany.mockResolvedValue(rows);

      const page = await service.findMine(USER, 1);

      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
    });
  });

  describe('unreadCount', () => {
    it('counts only the unread rows', async () => {
      prisma.notification.count.mockResolvedValue(3);

      await expect(service.unreadCount(USER)).resolves.toBe(3);

      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { recipientId: USER, readAt: null },
      });
    });
  });

  describe('markRead', () => {
    it('scopes the write to the caller and returns the row', async () => {
      const row = await service.markRead(USER, 'notif_1');

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'notif_1', recipientId: USER },
        data: dataContaining({ readAt: expect.any(Date) as unknown }),
      });
      expect(row.id).toBe('notif_1');
    });

    it('404s for a row that is not the caller’s', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.markRead(USER, 'notif_1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('markAllRead', () => {
    it('stamps every unread row at once', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 4 });

      await expect(service.markAllRead(USER)).resolves.toEqual({ updated: 4 });

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { recipientId: USER, readAt: null },
        data: dataContaining({ readAt: expect.any(Date) as unknown }),
      });
    });
  });

  describe('notifyForComment', () => {
    it('notifies the contributor on a top-level comment', async () => {
      await service.notifyForComment({
        resourceId: 'res_1',
        authorId: OTHER,
        parentId: null,
        commentId: 'cmt_9',
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          type: NotificationType.COMMENT_ON_RESOURCE,
          recipientId: USER,
          actorId: OTHER,
          resourceId: 'res_1',
          commentId: 'cmt_9',
        },
      });
      expect(push.sendForNotification).toHaveBeenCalledWith('notif_1');
    });

    it('notifies the parent author on a reply', async () => {
      await service.notifyForComment({
        resourceId: 'res_1',
        authorId: OTHER,
        parentId: 'cmt_1',
        commentId: 'cmt_9',
      });

      expect(prisma.comment.findUnique).toHaveBeenCalledWith({
        where: { id: 'cmt_1' },
        select: { authorId: true },
      });
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: dataContaining({
          type: NotificationType.REPLY_TO_COMMENT,
          recipientId: USER,
        }),
      });
    });

    it('files nothing for your own comment', async () => {
      await service.notifyForComment({
        resourceId: 'res_1',
        authorId: USER,
        parentId: null,
        commentId: 'cmt_9',
      });

      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('files nothing when the recipient is gone', async () => {
      prisma.resource.findUnique.mockResolvedValue({ contributorId: null });

      await service.notifyForComment({
        resourceId: 'res_1',
        authorId: OTHER,
        parentId: null,
        commentId: 'cmt_9',
      });

      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('never throws, so the comment survives a broken inbox', async () => {
      prisma.notification.create.mockRejectedValue(new Error('db is down'));

      await expect(
        service.notifyForComment({
          resourceId: 'res_1',
          authorId: OTHER,
          parentId: null,
          commentId: 'cmt_9',
        }),
      ).resolves.toBeUndefined();
    });
  });
});

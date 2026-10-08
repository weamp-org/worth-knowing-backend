import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';

import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '../generated/prisma/enums';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
  WebPushError: class WebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

const mockedWebpush = webpush as unknown as {
  setVapidDetails: jest.Mock;
  sendNotification: jest.Mock;
  WebPushError: new (message: string, statusCode: number) => Error;
};

/** A notification row shaped like the `notificationInclude` read. */
function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif_1',
    type: NotificationType.COMMENT_ON_RESOURCE,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    readAt: null,
    recipientId: 'user_1',
    actorId: 'user_2',
    actor: {
      id: 'user_2',
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

const SUBSCRIPTION = {
  endpoint: 'https://push.example.com/abc',
  p256dh: 'p256dh-key',
  auth: 'auth-key',
};

describe('PushService', () => {
  let service: PushService;
  let prisma: {
    notification: { findUnique: jest.Mock };
    pushSubscription: {
      findMany: jest.Mock;
      delete: jest.Mock;
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let configGet: jest.Mock;

  async function build() {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        {
          provide: PrismaService,
          useValue: {
            notification: {
              findUnique: jest.fn().mockResolvedValue(notificationRow()),
            },
            pushSubscription: {
              findMany: jest.fn().mockResolvedValue([]),
              delete: jest.fn(),
              upsert: jest.fn(),
              deleteMany: jest.fn(),
            },
          },
        },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get(PushService);
    prisma = module.get(PrismaService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    configGet = jest.fn(
      (key: string) =>
        ({
          VAPID_PUBLIC_KEY: 'public-key',
          VAPID_PRIVATE_KEY: 'private-key',
          VAPID_SUBJECT: 'https://worthknowing.weamp.org',
        })[key] ?? null,
    );

    await build();
    service.onModuleInit();
  });

  describe('onModuleInit', () => {
    it('registers VAPID details when all three variables are set', () => {
      expect(mockedWebpush.setVapidDetails).toHaveBeenCalledWith(
        'https://worthknowing.weamp.org',
        'public-key',
        'private-key',
      );
      expect(service.getPublicKey()).toBe('public-key');
    });

    it('stays disabled without keys rather than throwing at boot', async () => {
      configGet.mockReturnValue(null);

      await build();
      service.onModuleInit();

      expect(service.getPublicKey()).toBeNull();
    });
  });

  describe('subscribe', () => {
    it('upserts on the endpoint, so re-subscribing refreshes', async () => {
      await service.subscribe('user_1', {
        endpoint: SUBSCRIPTION.endpoint,
        keys: { p256dh: 'new-p256dh', auth: 'new-auth' },
      });

      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endpoint: SUBSCRIPTION.endpoint },
        }),
      );
    });
  });

  describe('unsubscribe', () => {
    it('scopes the delete to the caller', async () => {
      await service.unsubscribe('user_1', SUBSCRIPTION.endpoint);

      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: SUBSCRIPTION.endpoint, userId: 'user_1' },
      });
    });
  });

  describe('sendForNotification', () => {
    it('sends nothing when the recipient subscribed no browser', async () => {
      await service.sendForNotification('notif_1');

      expect(mockedWebpush.sendNotification).not.toHaveBeenCalled();
    });

    it('delivers the composed payload to every subscription', async () => {
      prisma.pushSubscription.findMany.mockResolvedValue([
        { ...SUBSCRIPTION, userId: 'user_1' },
      ]);

      await service.sendForNotification('notif_1');

      expect(mockedWebpush.sendNotification).toHaveBeenCalledTimes(1);
      const [, raw] = mockedWebpush.sendNotification.mock.calls[0] as [
        unknown,
        string,
      ];
      const payload = JSON.parse(raw) as { title: string; body: string };

      expect(payload.title).toBe('Grace Hopper');
      expect(payload.body).toContain('Sapiens');
    });

    it('prunes a dead subscription on 410 rather than failing forever', async () => {
      prisma.pushSubscription.findMany.mockResolvedValue([
        { ...SUBSCRIPTION, userId: 'user_1' },
      ]);
      mockedWebpush.sendNotification.mockRejectedValueOnce(
        new mockedWebpush.WebPushError('gone', 410),
      );

      await service.sendForNotification('notif_1');

      expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({
        where: { endpoint: SUBSCRIPTION.endpoint },
      });
    });

    it('never throws, so delivery cannot fail the inbox write', async () => {
      prisma.pushSubscription.findMany.mockRejectedValue(
        new Error('db is down'),
      );

      await expect(
        service.sendForNotification('notif_1'),
      ).resolves.toBeUndefined();
    });
  });
});

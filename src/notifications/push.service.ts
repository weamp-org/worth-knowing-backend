import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';

import { PrismaService } from '../prisma/prisma.service';
import { resolveDisplayName } from '../users/display-name.util';
import {
  notificationInclude,
  type NotificationWithRelations,
} from './notification-read';
import { SubscribePushDto } from './dtos/subscribe-push.dto';

/**
 * What a push notification carries.
 *
 * A path, not an absolute URL: the service worker resolves it against its own
 * origin, so the same payload is correct on production and on a preview
 * deployment. The worker opens `url` on tap — see `public/sw.js`.
 */
export type PushPayload = {
  title: string;
  body: string;
  icon: string;
  badge: string;
  url: string;
};

/**
 * Web Push delivery for the inbox.
 *
 * Subscriptions are per browser: one user on a phone and a laptop is two rows,
 * and every notification goes to all of them. Sending always fans out from the
 * recipient's live rows, so an unsubscribed browser simply has no row and a
 * deleted account takes its permissions with it (the relation cascades).
 *
 * Disabled without all three VAPID variables rather than throwing at boot: a
 * fresh clone has placeholder keys, and push is an enhancement — the inbox it
 * delivers to works without it. The disabled state warns once, loudly, so a
 * production deploy missing keys is noticed rather than silently quiet.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private enabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.config.get<string>('VAPID_SUBJECT');

    if (!publicKey || !privateKey || !subject) {
      this.logger.warn(
        'Push disabled: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT to enable it.',
      );
      return;
    }

    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.enabled = true;
  }

  /**
   * The key browsers subscribe with, or null when push is disabled.
   *
   * Served rather than baked into the frontend's env so there is exactly one
   * place VAPID keys live. Public by design — it identifies the server to the
   * push service and is useless without the private half.
   */
  getPublicKey(): string | null {
    if (!this.enabled) return null;

    return this.config.get<string>('VAPID_PUBLIC_KEY') ?? null;
  }

  /**
   * Records a browser's permission to be woken up.
   *
   * Upserted on the endpoint: re-subscribing the same browser refreshes its
   * keys rather than doubling the row, so toggling push off and on cannot
   * stack duplicate deliveries.
   */
  async subscribe(userId: string, dto: SubscribePushDto) {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userId,
      },
      update: {
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userId,
      },
    });

    return { subscribed: true };
  }

  /**
   * Forgets a browser.
   *
   * Scoped to the caller: endpoints are globally unique, but a delete that a
   * stranger's subscription could match would be a cross-account write, so the
   * row must be theirs. Idempotent — an already-gone subscription succeeds.
   */
  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({
      where: { endpoint, userId },
    });

    return { subscribed: false };
  }

  /**
   * Delivers one notification to every browser its recipient subscribed.
   *
   * Best-effort like the inbox write that precedes it: a push failure must
   * never fail anything. A dead subscription (the browser unsubscribed without
   * telling us — 404/410 from the push service) is pruned on sight, so the
   * table cannot fill with rows that only ever fail.
   */
  async sendForNotification(notificationId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const notification = await this.prisma.notification.findUnique({
        where: { id: notificationId },
        include: notificationInclude,
      });

      if (!notification) return;

      const subscriptions = await this.prisma.pushSubscription.findMany({
        where: { userId: notification.recipientId },
      });

      if (subscriptions.length === 0) return;

      const payload = this.composePayload(notification);

      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: {
                  p256dh: subscription.p256dh,
                  auth: subscription.auth,
                },
              },
              JSON.stringify(payload),
            );
          } catch (error) {
            if (
              error instanceof webpush.WebPushError &&
              (error.statusCode === 404 || error.statusCode === 410)
            ) {
              await this.prisma.pushSubscription.delete({
                where: { endpoint: subscription.endpoint },
              });
            } else {
              this.logger.warn(
                `Push to ${subscription.endpoint} failed: ${error instanceof Error ? error.message : error}`,
              );
            }
          }
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Push fan-out failed for notification ${notificationId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Words the notification for a lock screen.
   *
   * The actor's name is the title — it is what the recipient recognises — and
   * the resource title is truncated to what fits beside the action. A deleted
   * actor is "Someone", the same wording as the inbox; a deleted comment keeps
   * the row because somebody answering is still news.
   */
  private composePayload(notification: NotificationWithRelations): PushPayload {
    const actorName = notification.actor
      ? (resolveDisplayName({
          name: notification.actor.name,
          username: notification.actor.username,
        }) ?? 'Someone')
      : 'Someone';
    const title =
      notification.resource.title.length <= TITLE_LENGTH
        ? notification.resource.title
        : `${notification.resource.title.slice(0, TITLE_LENGTH).trimEnd()}…`;

    return {
      title: actorName,
      body:
        notification.type === 'REPLY_TO_COMMENT'
          ? `Replied to your comment on "${title}"`
          : `Commented on your resource "${title}"`,
      icon: '/icon-192x192.png',
      badge: '/icon-192x192.png',
      url: `/resources/${notification.resource.id}#comments-heading`,
    };
  }
}

/** Characters of resource title a push body carries before cutting. */
const TITLE_LENGTH = 80;

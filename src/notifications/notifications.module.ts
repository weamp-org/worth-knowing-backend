import { Module } from '@nestjs/common';

import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

// No `imports`: `PrismaModule` is `@Global()`, and
// `notifications/notification-read.ts` is a module of functions rather than an
// injectable service — the same arrangement `SavedModule` uses.
//
// Exported, because `CommentsService` files the notification a new comment
// earns. The write lives here so every notification enters through one door,
// while the trigger stays where the event happens.
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

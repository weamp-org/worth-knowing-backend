import { Module } from '@nestjs/common';

import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { CommentReportsController } from './comment-reports.controller';
import { NotificationsModule } from '../notifications/notifications.module';

// `PrismaModule` is `@Global()`, and `comments/comment-read.ts` is a module of
// functions rather than an injectable service, so neither needs wiring — the
// same arrangement `SavedModule` uses. `NotificationsModule` is imported for
// its service: filing the notification a new comment earns lives there, while
// the trigger stays here where the event happens.
//
// Two controllers on one service: the thread itself, and the admin queue. Separate
// because a queue is not part of any one thread and the two have different audiences.
@Module({
  imports: [NotificationsModule],
  controllers: [CommentsController, CommentReportsController],
  providers: [CommentsService],
})
export class CommentsModule {}

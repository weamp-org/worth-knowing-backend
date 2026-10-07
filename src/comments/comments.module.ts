import { Module } from '@nestjs/common';

import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { CommentReportsController } from './comment-reports.controller';

// No `imports`: `PrismaModule` is `@Global()`, and `comments/comment-read.ts` is a
// module of functions rather than an injectable service, so it needs no wiring — the
// same arrangement `SavedModule` uses.
//
// Two controllers on one service: the thread itself, and the admin queue. Separate
// because a queue is not part of any one thread and the two have different audiences.
@Module({
  controllers: [CommentsController, CommentReportsController],
  providers: [CommentsService],
})
export class CommentsModule {}

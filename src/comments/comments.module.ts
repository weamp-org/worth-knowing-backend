import { Module } from '@nestjs/common';

import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';

// No `imports`: `PrismaModule` is `@Global()`, and `comments/comment-read.ts` is a
// module of functions rather than an injectable service, so it needs no wiring — the
// same arrangement `SavedModule` uses.
@Module({
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}

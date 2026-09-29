import { Module } from '@nestjs/common';

import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';

// No `imports`: `PrismaModule` is `@Global()`, so `PrismaService` resolves here
// without it. Collections need nothing from `ResourcesModule` either — the
// resource read shape they share lives in `resources/resource-read.ts`, which is
// a module of functions rather than an injectable service.
@Module({
  controllers: [CollectionsController],
  providers: [CollectionsService],
})
export class CollectionsModule {}

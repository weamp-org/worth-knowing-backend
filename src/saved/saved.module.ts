import { Module } from '@nestjs/common';

import { SavedService } from './saved.service';
import { SavedController } from './saved.controller';

// No `imports`: `PrismaModule` is `@Global()`. The resource read shape comes from
// `resources/resource-read.ts`, which is a module of functions rather than an
// injectable service, so it needs no module wiring either.
@Module({
  controllers: [SavedController],
  providers: [SavedService],
})
export class SavedModule {}

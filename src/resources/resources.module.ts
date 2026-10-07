import { Module } from '@nestjs/common';

import { ResourcesService } from './resources.service';
import { ResourcesController } from './resources.controller';
import { ResourceReportsController } from './resource-reports.controller';
import { TagsModule } from '../tags/tags.module';

// Two controllers on one service: the resource itself, and its moderation queue.
// Separate because a queue is not part of any one resource and the two have
// different audiences.
@Module({
  imports: [TagsModule],
  controllers: [ResourcesController, ResourceReportsController],
  providers: [ResourcesService],
})
export class ResourcesModule {}

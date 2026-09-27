import { Module } from '@nestjs/common';

import { ResourcesService } from './resources.service';
import { ResourcesController } from './resources.controller';
import { TagsModule } from '../tags/tags.module';

@Module({
  imports: [TagsModule],
  controllers: [ResourcesController],
  providers: [ResourcesService],
})
export class ResourcesModule {}

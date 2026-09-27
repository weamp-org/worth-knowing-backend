import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { TagsService } from './tags.service';
import { ListTagsQueryDto } from './dtos/list-tags-query.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { Public } from '../public/public.decorator';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  /** Backs the tag typeahead. Omit `query` for the most-used tags. */
  @Get()
  @Public()
  search(@Query() query: ListTagsQueryDto) {
    return this.tagsService.search(query.query);
  }
}

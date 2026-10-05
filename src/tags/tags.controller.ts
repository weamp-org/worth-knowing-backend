import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { TagsService } from './tags.service';
import { ListTagsQueryDto } from './dtos/list-tags-query.dto';
import { UpdateTagDto } from './dtos/update-tag.dto';
import { TagSearchResultDto } from './dtos/tag-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { Public } from '../public/public.decorator';
import { UserRole } from '../generated/prisma/enums';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  /**
   * Backs the tag typeahead, and the tag nav on the home page and `/browse`.
   *
   * Omit `query` for the most-used tags. Omit `limit` and this is the same
   * most-used cut of twenty it has always returned — the parameter exists for
   * callers that genuinely want the whole vocabulary, not to lengthen the nav.
   */
  @Get()
  @Public()
  @ApiOperation({ summary: 'Search tags, most-used first' })
  @ApiOkResponse({ type: [TagSearchResultDto] })
  @ApiBadRequestResponse({ description: 'Invalid query parameter' })
  search(@Query() query: ListTagsQueryDto) {
    return this.tagsService.search(query.query, query.limit);
  }

  /**
   * One tag by its exact slug. Backs the public `/tags/:slug` page.
   *
   * **Exact, where the route above is a substring search.** That difference is
   * load-bearing rather than incidental: two tags answering to one URL would let
   * the one that is not the canonical slug take the canonical one's identity, and
   * `/tags/:slug` is a self-canonical page now, so that is a canonical pointing at
   * the wrong page.
   *
   * Declared after `GET /tags` so the literal path is not shadowed by `:slug`.
   *
   * Public and un-redacted, like every other tag read: a tag is vocabulary, not
   * somebody's account, so there is no contributor to withhold here.
   */
  @Get(':slug')
  @Public()
  @ApiOperation({ summary: 'Get one tag by its exact slug' })
  @ApiOkResponse({ type: TagSearchResultDto })
  @ApiNotFoundResponse({ description: 'No tag with that slug' })
  findBySlug(@Param('slug') slug: string) {
    return this.tagsService.findBySlug(slug);
  }

  /**
   * Renames a tag's display form. Admin only.
   *
   * There is no slug in the DTO, and that is deliberate rather than an
   * oversight. The slug is the tag's identity and it is what appears in
   * `/tags/<slug>` URLs, which other people have already linked; renaming it
   * would break every one of them, and a tag knows only the single name it was
   * created under, so there is nothing to redirect from.
   */
  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rename a tag (admin only)' })
  @ApiOkResponse({ type: TagSearchResultDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  @ApiNotFoundResponse({ description: 'No tag with that id' })
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.tagsService.updateName(id, dto.name);
  }

  /**
   * Deletes an unreferenced tag. Admin only.
   *
   * Refuses while the tag is still on any resource. Cascading instead would let
   * one call strip the tag from contributions by other people, which is the same
   * un-undoable bulk damage that keeps `DELETE /users/:id` from existing.
   *
   * This is also the only way the count can reach zero: tags are created
   * implicitly on resource write and nothing sweeps them, so a tag orphaned by a
   * deleted resource is otherwise unreachable.
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete an unreferenced tag (admin only)' })
  @ApiOkResponse({ type: TagSearchResultDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  @ApiNotFoundResponse({ description: 'No tag with that id' })
  @ApiConflictResponse({ description: 'Tag is still attached to resources' })
  remove(@Param('id') id: string) {
    return this.tagsService.remove(id);
  }
}

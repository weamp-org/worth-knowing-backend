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

  /** Backs the tag typeahead. Omit `query` for the most-used tags. */
  @Get()
  @Public()
  @ApiOperation({ summary: 'Search tags, most-used first' })
  @ApiOkResponse({ type: [TagSearchResultDto] })
  @ApiBadRequestResponse({ description: 'Invalid query parameter' })
  search(@Query() query: ListTagsQueryDto) {
    return this.tagsService.search(query.query);
  }

  /**
   * Renames a tag's display form. Admin only.
   *
   * There is no slug in the DTO, and that is deliberate rather than an
   * oversight. The slug is the tag's identity and it is what appears in
   * `/?tag=<slug>` URLs, which other people have already linked; renaming it
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

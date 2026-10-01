import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { SavedService } from './saved.service';
import { SaveResourceDto } from './dtos/save-resource.dto';
import { ListSavedQueryDto } from './dtos/list-saved-query.dto';
import { PaginatedResourcesResponseDto } from '../resources/dtos/resource-response.dto';
import { ResourceResponseDto } from '../resources/dtos/resource-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('saved')
export class SavedController {
  constructor(private readonly savedService: SavedService) {}

  /**
   * Your saved resources, newest saved first.
   *
   * Every route here is authenticated. A bookmark list is the most private thing
   * a person has on this site — it is the one collection of resources they have
   * chosen without saying why, and with no viewership to speak of. Unlike a
   * resource or a profile there is no public version of it, so no route is
   * `@Public()`.
   */
  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List your saved resources, newest saved first' })
  @ApiOkResponse({ type: PaginatedResourcesResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findMine(@CurrentUserId() userId: string, @Query() query: ListSavedQueryDto) {
    return this.savedService.findMine(userId, query.limit, query.cursor);
  }

  /**
   * Whether you saved this one.
   *
   * Separate from the resource body because it is the one per-viewer part: the
   * `savedCount` on a resource is public, this is not, and it is what decides
   * whether the button reads "Save" or "Saved" on arrival.
   */
  @Get(':resourceId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check whether you saved a resource' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { isSaved: { type: 'boolean' } } },
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  async isSaved(
    @Param('resourceId') resourceId: string,
    @CurrentUserId() userId: string,
  ) {
    return { isSaved: await this.savedService.isSaved(resourceId, userId) };
  }

  /**
   * Bookmarks a resource.
   *
   * Returns the resource rather than the saved row, because the caller wants the
   * refreshed `savedCount` to render and that lives on the resource.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Save a resource to your bookmark list',
    description:
      'Any resource on the site. Saving one twice succeeds and changes nothing. Independent of collections — a saved resource stays saved when you also collect it.',
  })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  save(@Body() body: SaveResourceDto, @CurrentUserId() userId: string) {
    return this.savedService.save(body.resourceId, userId);
  }

  /**
   * Removes a bookmark.
   *
   * Idempotent, so removing one you did not save succeeds and changes nothing
   * rather than 404ing.
   */
  @Delete(':resourceId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a resource from your saved list' })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  unsave(
    @Param('resourceId') resourceId: string,
    @CurrentUserId() userId: string,
  ) {
    return this.savedService.unsave(resourceId, userId);
  }
}

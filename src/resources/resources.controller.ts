import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { getAuth } from '@clerk/express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ResourcesService } from './resources.service';
import { CreateResourceDto } from './dtos/create-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';
import { ListResourcesQueryDto } from './dtos/list-resources-query.dto';
import { ReportResourceDto } from './dtos/report-resource.dto';
import {
  PaginatedResourcesResponseDto,
  ResourceResponseDto,
} from './dtos/resource-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';
import { Public } from '../public/public.decorator';
import { PUBLIC_WRITE_THROTTLE } from '../throttle';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Share a resource' })
  @ApiCreatedResponse({ type: ResourceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiConflictResponse({
    description: 'You have already shared this link',
  })
  create(
    @CurrentUserId() contributorId: string,
    @Body() createResourceDto: CreateResourceDto,
  ) {
    return this.resourcesService.create(createResourceDto, contributorId);
  }

  @Get()
  @Public()
  @ApiOperation({
    summary: 'List or search resources, filtered by tag, type and access level',
    description:
      'Filters combine freely: `tag`, `contributor`, `type`, `accessType`. Without `sort` the order is newest first, or relevance when `q` is present — relevance is the absence of `sort`, so `q` with a `sort` means every match in that order. The `nextCursor` is only valid for the same query: relevance paging carries a score, every other ordering a bare id. Every page carries `facets`: counts per type and per access level for the current query, where each facet ignores its own filter so the dropdowns can show what switching to an option would yield.',
  })
  @ApiOkResponse({ type: PaginatedResourcesResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  findAll(@Query() query: ListResourcesQueryDto, @Req() request: Request) {
    // Read even on a public route: `@Public()` skips the guard, but Clerk's
    // middleware has still parsed the session, so a contributor browsing their
    // own anonymous posts sees them attributed.
    return this.resourcesService.findAll({
      tag: query.tag,
      limit: query.limit,
      cursor: query.cursor,
      contributorUsername: query.contributor,
      q: query.q,
      type: query.type,
      accessType: query.accessType,
      sort: query.sort,
      viewerId: getAuth(request).userId ?? undefined,
    });
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get one resource' })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  findOne(@Param('id') id: string, @Req() request: Request) {
    return this.resourcesService.findOne(
      id,
      getAuth(request).userId ?? undefined,
    );
  }

  /**
   * Whether the caller contributed this resource.
   *
   * Separate from the resource body because a resource shared anonymously is
   * redacted, so its own response cannot say who wrote it. The client needs
   * that answer to decide whether to offer an edit.
   */
  @Get(':id/mine')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check whether you contributed a resource' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { isMine: { type: 'boolean' } } },
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  async isMine(@Param('id') id: string, @CurrentUserId() userId: string) {
    return { isMine: await this.resourcesService.isMine(id, userId) };
  }

  @Patch(':id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update a resource you contributed (admins may update any)',
  })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({
    description: 'Caller did not contribute this resource and is not an admin',
  })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  @ApiConflictResponse({
    description: 'The new URL is already one of this contributor’s resources',
  })
  update(
    @Param('id') id: string,
    @Body() updateResourceDto: UpdateResourceDto,
    @CurrentUserId() userId: string,
  ) {
    return this.resourcesService.update(id, updateResourceDto, userId);
  }

  /**
   * Removes a resource for everyone, permanently.
   *
   * The contributor may do this to their own contribution, which is the only
   * self-service correction the product offers — share something you regret and
   * take it down again. The `why` goes with it, which is why the client confirms
   * rather than just calling this.
   *
   * There is deliberately no "un-attribute" alternative. Anonymity already hides
   * the name *and* keeps the resource editable, so detaching the contributor
   * outright would only take away the author's ability to fix a typo. A
   * contributor who wants the resource gone gets it gone; one who wants the name
   * gone flips `isAnonymous` instead.
   *
   * Authorization is in the service, not here: `RolesGuard` short-circuits when a
   * route declares no `@Roles`, so a rule that admits either an owner or an
   * admin has to be expressed where the role is actually read.
   */
  /**
   * Flags a resource for a moderator.
   *
   * Sits on the resource rather than on the comment because a contribution is the
   * higher-leverage thing to remove: a bad comment is one person's remark under one
   * page, while a bad link gets shared onward to people who never saw the flag.
   *
   * `204`, and nothing about it is visible to any reader — including the
   * contributor. A report is a quiet signal, and telling somebody they were reported
   * would turn it into a scoreboard. Unlike a comment report there is nothing on the
   * page that says "this was flagged", so the only response is silence either way.
   *
   * Idempotent, and the composite primary key is what makes it so: one account
   * cannot pad a resource's report count to make it look worse than it is.
   */
  @Post(':id/report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(PUBLIC_WRITE_THROTTLE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Report a resource to the moderators',
    description:
      'Idempotent. Only admins see reported resources. You cannot report your own contribution.',
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or you tried to report your own contribution',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  report(
    @Param('id') id: string,
    @CurrentUserId() reporterId: string,
    @Body() dto: ReportResourceDto,
  ) {
    return this.resourcesService.report(id, reporterId, dto);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete a resource you contributed (admins may delete any)',
  })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({
    description: 'Caller did not contribute this resource and is not an admin',
  })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  remove(@Param('id') id: string, @CurrentUserId() userId: string) {
    return this.resourcesService.remove(id, userId);
  }
}

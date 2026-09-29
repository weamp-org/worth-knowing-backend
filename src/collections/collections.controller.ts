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
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dtos/create-collection.dto';
import { UpdateCollectionDto } from './dtos/update-collection.dto';
import { AddResourceToCollectionDto } from './dtos/add-resource-to-collection.dto';
import {
  ListCollectionResourcesQueryDto,
  ListMyCollectionsQueryDto,
  ListPublicCollectionsQueryDto,
} from './dtos/list-collections-query.dto';
import {
  CollectionResponseDto,
  PaginatedCollectionResourcesResponseDto,
  PaginatedCollectionsResponseDto,
} from './dtos/collection-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';
import { Public } from '../public/public.decorator';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  /**
   * The caller's own collections, newest first.
   *
   * Declared before `:id` on purpose. Nest matches routes in declaration order,
   * and `:id` is a single path segment, so a route declared above would still be
   * matched first — but keeping the literal segment first means the literal
   * cannot be shadowed by an id that happens to look like it.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List your own collections, newest first',
    description:
      'Pass ?resourceId= to learn, per collection, whether it already holds that resource.',
  })
  @ApiOkResponse({ type: PaginatedCollectionsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findMine(
    @CurrentUserId() ownerId: string,
    @Query() query: ListMyCollectionsQueryDto,
  ) {
    return this.collectionsService.findMine(
      ownerId,
      query.resourceId,
      query.limit,
      query.cursor,
    );
  }

  /**
   * Public collections, newest first.
   *
   * `?owner=` narrows it to one person, which is how a profile page lists them.
   * That is currently the only caller, and deliberately so — a public collection
   * is a statement by somebody about their taste, which belongs beside the
   * contributions that express the same taste, not in a ranked index of its own.
   *
   * Declared after `me` and before `:id`, so neither literal is shadowed.
   */
  @Get()
  @Public()
  @ApiOperation({
    summary: 'List public collections, optionally one owner’s',
  })
  @ApiOkResponse({ type: PaginatedCollectionsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  findPublic(
    @Query() query: ListPublicCollectionsQueryDto,
    @Req() request: Request,
  ) {
    return this.collectionsService.findPublic(
      query.owner,
      query.limit,
      query.cursor,
      getAuth(request).userId ?? undefined,
    );
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get one collection' })
  @ApiOkResponse({ type: CollectionResponseDto })
  @ApiNotFoundResponse({
    description: 'No collection with that id, or it is private and not yours',
  })
  findOne(@Param('id') id: string, @Req() request: Request) {
    // Read the session even on a public route: `@Public()` skips the guard, but
    // Clerk's middleware has still parsed it, so an owner opening their own
    // private collection is let through and gets `isOwner: true`. A stranger
    // presenting any token gets the same 404 as a signed-out visitor.
    return this.collectionsService.findOne(
      id,
      getAuth(request).userId ?? undefined,
    );
  }

  @Get(':id/resources')
  @Public()
  @ApiOperation({
    summary: "List a collection's resources, newest collected first",
  })
  @ApiOkResponse({ type: PaginatedCollectionResourcesResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor' })
  @ApiNotFoundResponse({
    description: 'No collection with that id, or it is private and not yours',
  })
  listResources(
    @Param('id') id: string,
    @Query() query: ListCollectionResourcesQueryDto,
    @Req() request: Request,
  ) {
    return this.collectionsService.listResources(
      id,
      getAuth(request).userId ?? undefined,
      query.limit,
      query.cursor,
    );
  }

  @Post()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a collection, private unless you say otherwise',
  })
  @ApiCreatedResponse({ type: CollectionResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  create(
    @CurrentUserId() ownerId: string,
    @Body() createCollectionDto: CreateCollectionDto,
  ) {
    return this.collectionsService.create(createCollectionDto, ownerId);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update a collection you own (admins may update any)',
  })
  @ApiOkResponse({ type: CollectionResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({
    description: 'Caller does not own this collection and is not an admin',
  })
  @ApiNotFoundResponse({ description: 'No collection with that id' })
  update(
    @Param('id') id: string,
    @Body() updateCollectionDto: UpdateCollectionDto,
    @CurrentUserId() userId: string,
  ) {
    return this.collectionsService.update(id, updateCollectionDto, userId);
  }

  /**
   * Removes a collection, permanently.
   *
   * The owner may do this to their own collection, and so may an admin. The
   * resources inside are untouched — they are still attributed to whoever shared
   * them — and only the owner's own arrangement of them goes away.
   */
  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete a collection you own (admins may delete any)',
  })
  @ApiOkResponse({ type: CollectionResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({
    description: 'Caller does not own this collection and is not an admin',
  })
  @ApiNotFoundResponse({ description: 'No collection with that id' })
  remove(@Param('id') id: string, @CurrentUserId() userId: string) {
    return this.collectionsService.remove(id, userId);
  }

  /**
   * Puts any resource into one of your collections.
   *
   * Owner-only, with no admin path, which is the one place this controller's
   * authorization differs from `PATCH` and `DELETE` above. Curating is personal
   * rather than public content, and an admin quietly inserting a link into
   * somebody's reading list would be indefensible. See the service for the full
   * reasoning.
   *
   * Idempotent: a resource already in the collection is not an error.
   *
   * Hence `@HttpCode(200)` rather than Nest's default 201. Nothing is created —
   * the row either exists or is a no-op — and a 201 would tell a client it was,
   * which is wrong on the second call and inconsistent with the delete half of
   * this pair, which is also 200.
   */
  @Post(':id/resources')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Add a resource to a collection you own',
    description:
      'Any resource on the site, not only your own. Adding one that is already there succeeds and changes nothing.',
  })
  @ApiOkResponse({ type: CollectionResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'You do not own this collection' })
  @ApiNotFoundResponse({
    description: 'No collection with that id, or no resource with that id',
  })
  addResource(
    @Param('id') id: string,
    @Body() body: AddResourceToCollectionDto,
    @CurrentUserId() userId: string,
  ) {
    return this.collectionsService.addResource(id, body.resourceId, userId);
  }

  /**
   * Takes a resource out of one of your collections.
   *
   * Removing one that is not there succeeds and changes nothing, so the route
   * answers 200 rather than 404.
   */
  @Delete(':id/resources/:resourceId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a resource from a collection you own' })
  @ApiOkResponse({ type: CollectionResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'You do not own this collection' })
  @ApiNotFoundResponse({ description: 'No collection with that id' })
  removeResource(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @CurrentUserId() userId: string,
  ) {
    return this.collectionsService.removeResource(id, resourceId, userId);
  }
}

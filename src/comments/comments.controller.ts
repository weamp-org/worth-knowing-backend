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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { getAuth } from '@clerk/express';
import { Throttle } from '@nestjs/throttler';
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

import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dtos/create-comment.dto';
import { ReportCommentDto } from './dtos/report-comment.dto';
import { ListCommentsQueryDto } from './dtos/list-comments-query.dto';
import {
  CommentResponseDto,
  PaginatedCommentsResponseDto,
} from './dtos/comment-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';
import { Public } from '../public/public.decorator';

/**
 * How fast one person may post comments, per hour.
 *
 * Overridden on the create route alone. The global limit is 100 requests a minute,
 * which is the right shape for reads and far too generous for the one write on this
 * site that produces public free text: a hundred comments a minute from one account
 * is a spam cannon, and no amount of after-the-fact reporting un-sends it.
 *
 * Generous for an ordinary person — an hour of solid conversation is not a hundred
 * comments — and tight enough that bulk posting needs more accounts than a bored
 * person has.
 */
const COMMENT_WRITE_THROTTLE = { default: { limit: 10, ttl: 3_600_000 } };

/**
 * Nested under the resource rather than mounted at `/comments`.
 *
 * The resource is the context a comment is meaningless without: a comment answers a
 * specific `why`, and there is no such thing as a comment floating free. Nesting
 * also means the listing cannot be asked without naming what is being discussed,
 * which is what stops a single unbounded "all comments on the site" table.
 */
@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('resources/:resourceId/comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  /**
   * The comments on a resource, newest first.
   *
   * Public, unlike every saved route. Discussion is part of the public surface of a
   * resource, and `commentCount` is already on the public resource response — a count
   * a signed-out reader can see with nothing behind it would be the odd outcome.
   */
  @Get()
  @Public()
  @ApiOperation({ summary: 'List a resource’s comments, newest first' })
  @ApiOkResponse({ type: PaginatedCommentsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  findAll(
    @Param('resourceId') resourceId: string,
    @Query() query: ListCommentsQueryDto,
    @Req() request: Request,
  ) {
    // Read even on a public route: `@Public()` skips the guard, but Clerk's
    // middleware has still parsed the session, so `isMine` is right for a signed-in
    // reader on first paint rather than appearing a tick later.
    return this.commentsService.findForResource(
      resourceId,
      query.limit,
      query.cursor,
      getAuth(request).userId ?? undefined,
    );
  }

  /**
   * Posts a comment.
   *
   * `201`, because a comment is created rather than idempotently set. Posting the
   * same text twice is two comments — unlike a save, which is a single row either
   * way.
   *
   * Open on any resource, including one shared anonymously: discussing an anonymous
   * contribution does not un-withhold the contributor.
   */
  @Post()
  @Throttle(COMMENT_WRITE_THROTTLE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Comment on a resource, or reply to one comment',
    description:
      'Any resource on the site. Pass `parentId` to reply; a reply to a reply is flattened to one level.',
  })
  @ApiCreatedResponse({ type: CommentResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation failed, or the body is blank',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({
    description: 'No resource with that id, or no parent comment on it',
  })
  create(
    @Param('resourceId') resourceId: string,
    @CurrentUserId() authorId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentsService.create(resourceId, authorId, dto);
  }

  /**
   * Removes a comment. The author, or an admin.
   *
   * `204`. The resource segment is required even though the delete itself only needs
   * the comment id: deleting `/resources/:resourceId/comments/:id` where that id
   * belongs to a different resource is a 404, which is a mistake worth surfacing
   * rather than quietly ignoring a path segment the caller got wrong.
   *
   * Authorization is in the service: `RolesGuard` short-circuits when a route declares
   * no `@Roles`, so a rule admitting either an author or an admin cannot be expressed
   * with that decorator.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Remove a comment you wrote (admins may remove any)',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({
    description: 'Caller did not write this comment and is not an admin',
  })
  @ApiNotFoundResponse({
    description: 'No comment with that id on this resource',
  })
  remove(
    @Param('resourceId') resourceId: string,
    @Param('id') id: string,
    @CurrentUserId() actorId: string,
  ) {
    return this.commentsService.remove(resourceId, id, actorId);
  }

  /**
   * Flags a comment for a moderator. Signed in only.
   *
   * `204`, and the reported comment looks exactly as it did before — the report is
   * invisible to everyone but an admin. Nothing about reporting is shown to the
   * comment's author, because that would turn a quiet signal into a scoreboard.
   *
   * Idempotent, for the same reason save is: a `409` would punish a double-click when
   * the state the caller asked for already holds. It also means one account cannot
   * pad a comment's report count.
   *
   * Throttled on the comment write budget, since reporting is a write that a bored
   * person could otherwise run a few thousand of.
   */
  @Post(':id/report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(COMMENT_WRITE_THROTTLE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Report a comment to the moderators',
    description:
      'Idempotent. Only admins see reported comments. You cannot report your own.',
  })
  @ApiBadRequestResponse({
    description: 'Validation failed, or you tried to report your own comment',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({
    description: 'No comment with that id on this resource',
  })
  report(
    @Param('resourceId') resourceId: string,
    @Param('id') id: string,
    @CurrentUserId() reporterId: string,
    @Body() dto: ReportCommentDto,
  ) {
    return this.commentsService.report(resourceId, id, reporterId, dto);
  }
}

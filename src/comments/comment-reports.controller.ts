import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CommentsService } from './comments.service';
import { ListCommentsQueryDto } from './dtos/list-comments-query.dto';
import { PaginatedCommentReportsResponseDto } from './dtos/comment-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { UserRole } from '../generated/prisma/enums';

/**
 * The moderation queue: comments people have reported.
 *
 * Mounted at `/comment-reports` rather than under `/resources/:resourceId/comments`,
 * because a queue is not part of any one thread. A moderator wants everything that has
 * been flagged, ordered by when it was flagged — asking for that through a resource
 * path would mean knowing which resource to ask about.
 *
 * Separate from `CommentsController` because this is the one place in the comments
 * feature that is not about a conversation. It is the surface `DELETE /users/:id` is
 * kept out of waiting for: reporting and the reputation model that goes with it.
 */
@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('comment-reports')
export class CommentReportsController {
  constructor(private readonly commentsService: CommentsService) {}

  /**
   * Reported comments, newest report first.
   *
   * Admin only, via `@Roles` rather than a check in the service — this is a route
   * that admits *only* admins, which is the one case the decorator can express, and
   * unlike the author-or-admin rules elsewhere it does not need to accept an owner.
   *
   * The reporting itself needs no session to be meaningful: any signed-in person can
   * file one, which is the point. Only reading the queue is restricted.
   */
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List reported comments (admin only)',
    description:
      'One row per report, newest first. Reporters are never named — a moderator sees what was flagged and what was said, not who said it.',
  })
  @ApiOkResponse({ type: PaginatedCommentReportsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  findAll(@Query() query: ListCommentsQueryDto) {
    return this.commentsService.listReports(query.limit, query.cursor);
  }
}

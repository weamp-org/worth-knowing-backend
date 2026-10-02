import {
  Controller,
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

  /**
   * Marks a reported comment as dealt with, without removing it.
   *
   * The third thing a moderator can do with a report, alongside removing the comment
   * and doing nothing. Without it there is no way to record "I looked and it stays",
   * so the queue can only ever be worked through by deleting things — which quietly
   * makes removal the answer to every report, including the ones where removal is
   * wrong.
   *
   * `204`, and deliberately **not** `DELETE`: nothing is deleted. The comment stays,
   * the report rows stay, and the queue simply stops returning them.
   *
   * Takes the comment id rather than a report id, because a comment several people
   * reported is several rows and one decision has to close all of them. That is what
   * makes a queue finishable.
   *
   * Idempotent: two moderators reaching for the same row at once is ordinary, and
   * neither should see an error for it.
   *
   * **No confirmation dialog on the client**, and that is deliberate rather than an
   * oversight. Dismissal deletes nothing — the comment and the report rows both stay,
   * and `dismissedAt` is a nullable column — so it is the reversible action and
   * confirmation belongs on the irreversible one. Asking here would also make
   * dismissal feel as heavy as removal, and the path of least resistance would then
   * be remove-or-do-nothing: friction on exactly the decision a moderator should be
   * making more often. `docs/comments.md` records the reasoning.
   *
   * The recovery path is {@link undismiss}, which the client offers as an Undo on the
   * toast rather than as a dialog before the action.
   */
  @Post(':commentId/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Dismiss every report on a comment (admin only)',
    description:
      'The comment is not removed — it stops appearing in the queue. Reversible with the undismiss route. Use the ordinary comment delete to remove it.',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  dismiss(@Param('commentId') commentId: string) {
    return this.commentsService.dismiss(commentId);
  }

  /**
   * Puts a dismissed comment's reports back in the queue.
   *
   * Exists because "reversible in the database" is not "reversible for you". Without
   * it, dismissal is the one moderation action with no safety net at all, and a
   * mis-click is permanent in practice — which is why the client offers this as an
   * **Undo on the toast** rather than asking for confirmation first.
   *
   * An Undo that restores the rows to the queue is the better shape for two reasons:
   * a confirmation dialog costs every moderator two clicks on the safe action to
   * guard against one rare mistake, and a dialog on every moderation action is how
   * people learn to click through dialogs — including the delete one, which is the
   * one that actually needs reading. See `docs/profiles.md` for the same principle
   * applied to saving a profile.
   *
   * Only rows a dismissal actually closed are reopened. A report filed *after* the
   * dismissal has `dismissedAt: null` already and is in the queue; this leaves it
   * alone rather than touching its timestamp.
   *
   * Idempotent, like the dismissal it reverses.
   */
  @Post(':commentId/undismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reopen every dismissed report on a comment (admin only)',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  undismiss(@Param('commentId') commentId: string) {
    return this.commentsService.undismiss(commentId);
  }
}

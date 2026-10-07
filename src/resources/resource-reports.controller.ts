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

import { ResourcesService } from './resources.service';
import { PaginatedResourceReportsResponseDto } from './dtos/resource-response.dto';
import { PaginationQueryDto } from '../pagination/pagination-query.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { UserRole } from '../generated/prisma/enums';

/**
 * The moderation queue: contributions people have reported.
 *
 * Mounted at `/resource-reports` rather than under `/resources/:id`, for the same
 * reason the comment queue is at `/comment-reports`: a queue is not part of any one
 * resource, and a moderator wants everything that has been flagged, ordered by when it
 * was flagged.
 *
 * Two queues rather than one merged list. Both tables page over their own keyset and
 * merging them would mean a cursor spanning two unrelated orderings — the same
 * problem `docs/saved.md` refused sort-by-saved for. Two independently-paginated
 * sections on one `/moderation` page is the honest arrangement, and each is far more
 * likely to be empty than not.
 */
@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('resource-reports')
export class ResourceReportsController {
  constructor(private readonly resourcesService: ResourcesService) {}

  /**
   * Reported resources, newest report first.
   *
   * Admin only, via `@Roles` — the one case the decorator can state, since there is
   * no owner-of-the-queue alternative for a non-admin to be. Reporting itself needs
   * no privilege at all; that is the point of it.
   *
   * Takes {@link PaginationQueryDto} rather than `ListResourcesQueryDto` even though
   * this controller used to take the latter. Only a page size and a cursor mean
   * anything on a moderation queue, and `forbidNonWhitelisted` would otherwise make
   * `?q=` validate here and then be quietly dropped — an admin narrowing the queue
   * by a search term and getting the unfiltered answer with no indication of it.
   */
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List reported resources (admin only)',
    description:
      'One row per report, newest first. Reporters are never named, and an anonymously shared contribution is still redacted here.',
  })
  @ApiOkResponse({ type: PaginatedResourceReportsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.resourcesService.listResourceReports(query.limit, query.cursor);
  }

  /**
   * Marks a reported contribution as dealt with, without removing it.
   *
   * The third thing a moderator can do with a report, alongside removing the
   * contribution and doing nothing. Without it the only way to work through the queue
   * is to delete things — which quietly makes removal the answer to every report,
   * including a `BROKEN_LINK` on a `why` that is worth keeping and fixing.
   *
   * `204`, and deliberately **not** `DELETE`: nothing is deleted. The contribution
   * stays, the report rows stay, and the queue stops returning them.
   *
   * Takes the resource id rather than a report id, because a contribution several
   * people reported is several rows and one decision has to close all of them. That is
   * what makes a queue finishable.
   *
   * Idempotent: two moderators reaching for the row at once is ordinary, and neither
   * should see an error for it.
   *
   * **No confirmation dialog on the client**, and that is deliberate rather than an
   * oversight. Dismissal deletes nothing — the contribution and the report rows both
   * stay, and `dismissedAt` is a nullable column — so it is the reversible action and
   * confirmation belongs on the irreversible one. Asking here would also make
   * dismissal feel as heavy as removal, and the path of least resistance would then be
   * remove-or-do-nothing: friction on exactly the decision a moderator should be
   * making more often. `docs/comments.md` records the reasoning.
   *
   * The recovery path is {@link undismiss}, offered as an Undo on the toast.
   */
  @Post(':resourceId/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Dismiss every report on a contribution (admin only)',
    description:
      'The contribution is not removed — it stops appearing in the queue. Use the ordinary resource delete to remove it.',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  dismiss(@Param('resourceId') resourceId: string) {
    return this.resourcesService.dismiss(resourceId);
  }

  /**
   * Puts a dismissed contribution's reports back in the queue.
   *
   * Exists because "reversible in the database" is not "reversible for you". Without
   * it, dismissal is the one moderation action with no safety net, and a mis-click is
   * permanent in practice — which is why the client offers this as an **Undo on the
   * toast** rather than asking for confirmation first.
   *
   * An Undo that restores the rows is the better shape for two reasons: a confirmation
   * dialog costs every moderator two clicks on the safe action to guard against one
   * rare mistake, and a dialog on every moderation action is how people learn to click
   * through them — including the remove one, which is the only one that genuinely
   * needs reading.
   *
   * Only rows a dismissal actually closed are reopened. A report filed *after* the
   * dismissal is already in the queue and is left exactly where it is.
   *
   * Idempotent, like the dismissal it reverses.
   */
  @Post(':resourceId/undismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reopen every dismissed report on a contribution (admin only)',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  undismiss(@Param('resourceId') resourceId: string) {
    return this.resourcesService.undismiss(resourceId);
  }
}

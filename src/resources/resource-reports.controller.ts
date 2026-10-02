import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ResourcesService } from './resources.service';
import { ListResourcesQueryDto } from './dtos/list-resources-query.dto';
import { PaginatedResourceReportsResponseDto } from './dtos/resource-response.dto';
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
  findAll(@Query() query: ListResourcesQueryDto) {
    return this.resourcesService.listResourceReports(query.limit, query.cursor);
  }
}

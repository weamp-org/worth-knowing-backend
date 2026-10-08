import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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

import { NotificationsService } from './notifications.service';
import { ListNotificationsQueryDto } from './dtos/list-notifications-query.dto';
import {
  NotificationResponseDto,
  PaginatedNotificationsResponseDto,
} from './dtos/notification-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Your inbox, newest first.
   *
   * Every route here is authenticated. A notification names who said what
   * about whose contribution — there is no public version of that, so no
   * route is `@Public()`.
   */
  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List your notifications, newest first' })
  @ApiOkResponse({ type: PaginatedNotificationsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameter or cursor' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findMine(
    @CurrentUserId() userId: string,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notificationsService.findMine(
      userId,
      query.limit,
      query.cursor,
    );
  }

  /**
   * How many of your notifications are unread.
   *
   * Separate from the list because the header bell polls this and nothing
   * else — refetching a page of rows to read a number off it would be the list
   * endpoint doing a counter's job.
   */
  @Get('unread-count')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Count your unread notifications' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { count: { type: 'number' } } },
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  async unreadCount(@CurrentUserId() userId: string) {
    return { count: await this.notificationsService.unreadCount(userId) };
  }

  /**
   * Marks one notification read.
   *
   * Returns it, so the client can settle the row without refetching the page.
   * Idempotent: reading what is already read succeeds and re-stamps it.
   */
  @Patch(':id/read')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiOkResponse({ type: NotificationResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({ description: 'No notification with that id' })
  markRead(@Param('id') id: string, @CurrentUserId() userId: string) {
    return this.notificationsService.markRead(userId, id);
  }

  /**
   * Marks the whole inbox read.
   *
   * `POST` rather than `PATCH` because there is no resource being partially
   * updated — this is an action on the collection, and it returns the count so
   * the bell can settle without refetching.
   */
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark all your notifications read' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { updated: { type: 'number' } } },
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  markAllRead(@CurrentUserId() userId: string) {
    return this.notificationsService.markAllRead(userId);
  }
}

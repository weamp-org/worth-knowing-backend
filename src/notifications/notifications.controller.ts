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
import { PushService } from './push.service';
import { ListNotificationsQueryDto } from './dtos/list-notifications-query.dto';
import {
  NotificationResponseDto,
  PaginatedNotificationsResponseDto,
} from './dtos/notification-response.dto';
import { SubscribePushDto } from './dtos/subscribe-push.dto';
import { UnsubscribePushDto } from './dtos/unsubscribe-push.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

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

  /**
   * The VAPID public key browsers subscribe with.
   *
   * Served rather than baked into the frontend's env so there is exactly one
   * place the keys live. Public by design — it identifies this server to the
   * push service and is useless without the private half — but authenticated
   * anyway, because only a signed-in browser has any use for it.
   */
  @Get('push-public-key')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the VAPID public key for push subscribe' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { publicKey: { type: 'string' } } },
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  pushPublicKey() {
    return { publicKey: this.pushService.getPublicKey() };
  }

  /**
   * Records this browser for push delivery.
   *
   * Upserted on the endpoint, so re-subscribing refreshes rather than doubles
   * — toggling push off and on cannot stack duplicate deliveries.
   */
  @Post('push-subscriptions')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Subscribe this browser for push notifications' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { subscribed: { type: 'boolean' } } },
  })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  subscribePush(
    @Body() body: SubscribePushDto,
    @CurrentUserId() userId: string,
  ) {
    return this.pushService.subscribe(userId, body);
  }

  /**
   * Forgets this browser.
   *
   * Idempotent: an already-gone subscription succeeds. Scoped to the caller
   * so one account cannot unsubscribe another's browser.
   */
  @Delete('push-subscriptions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unsubscribe this browser from push notifications' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { subscribed: { type: 'boolean' } } },
  })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  unsubscribePush(
    @Body() body: UnsubscribePushDto,
    @CurrentUserId() userId: string,
  ) {
    return this.pushService.unsubscribe(userId, body.endpoint);
  }
}

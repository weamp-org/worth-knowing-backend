import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { UsersService } from './users.service';
import { UpdateMySettingsDto } from './dtos/update-my-settings.dto';
import { MySettingsDto } from './dtos/user-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';

/**
 * The caller's own settings. That is the whole controller.
 *
 * The template shipped `POST /users`, `GET /users`, `GET /users/:id`,
 * `PATCH /users/:id` and `DELETE /users/:id`. All five are gone:
 *
 * - Users are provisioned automatically by `ClerkAuthGuard` on the first
 *   authenticated request, so `POST /users` had nobody to serve.
 * - `name`, `email` and `imageUrl` are owned by Clerk. `WebhooksService`
 *   overwrites all three on every Clerk event, so `PATCH /users/:id` would
 *   write a value that silently reverts, and would disagree with Clerk until
 *   that happened.
 * - `GET /users` handed every signed-in caller a list of everyone's email
 *   addresses.
 * - `DELETE /users/:id` is deliberately kept out. It is unreachable from the
 *   product — no admin surface, no user list, nothing to discover it from — and
 *   it is destructive and un-undoable: deleting a user sets `contributorId` to
 *   NULL on every resource they contributed, permanently removing their name
 *   from all of it. A moderation capability that has not been designed should
 *   not exist as a raw endpoint. When it is built, it should arrive with the
 *   reporting and reputation model it needs.
 *
 * `UserRole.ADMIN` is not orphaned by this: `DELETE /resources/:id` still uses
 * it, so `pnpm user:set-role` still has a purpose.
 */
@UseGuards(ClerkAuthGuard, RolesGuard)
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me/settings')
  @ApiOperation({ summary: 'Get your own settings' })
  @ApiOkResponse({ type: MySettingsDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findMySettings(@CurrentUserId() userId: string) {
    return this.usersService.findMySettings(userId);
  }

  @Patch('me/settings')
  @ApiOperation({ summary: 'Update your own settings' })
  @ApiOkResponse({ type: MySettingsDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  updateMySettings(
    @CurrentUserId() userId: string,
    @Body() dto: UpdateMySettingsDto,
  ) {
    return this.usersService.updateMySettings(userId, dto);
  }
}

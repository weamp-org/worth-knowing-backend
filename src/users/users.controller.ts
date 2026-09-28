import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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

import { UsersService } from './users.service';
import { UpdateMySettingsDto } from './dtos/update-my-settings.dto';
import { MySettingsDto } from './dtos/user-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { UserRole } from '../generated/prisma/enums';

/**
 * The caller's own record, and the one way an admin can remove an account.
 *
 * The template shipped `POST /users`, `GET /users`, `GET /users/:id` and
 * `PATCH /users/:id`. All four are gone, because none of them were reachable
 * from the product and two were actively wrong:
 *
 * - Users are provisioned automatically by `ClerkAuthGuard` on the first
 *   authenticated request, so `POST /users` had no caller.
 * - `name`, `email` and `imageUrl` are owned by Clerk. `WebhooksService`
 *   overwrites all three on every Clerk event, so `PATCH /users/:id` would
 *   write a value that silently reverts, and would disagree with Clerk until
 *   that happened.
 * - `GET /users` handed every signed-in caller a list of everyone's email
 *   addresses.
 *
 * What is genuinely the user's to set lives at `me/settings`.
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

  /**
   * The only remaining user route. Kept because it is the sole way an admin can
   * act on an account, and removing a destructive capability is a product call
   * rather than a cleanup.
   *
   * Their resources survive with `contributorId` set to NULL, so removing
   * someone does not remove what they contributed.
   */
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a user (admin only)' })
  @ApiOkResponse({ description: 'The deleted user' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
}

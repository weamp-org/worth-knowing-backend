import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { getAuth } from '@clerk/express';

import { UsersService } from './users.service';
import { UpdateMySettingsDto } from './dtos/update-my-settings.dto';
import { MySettingsDto } from './dtos/user-response.dto';
import { UpdateMyProfileDto } from './dtos/update-my-profile.dto';
import { ProfileResponseDto } from './dtos/profile-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';
import { Public } from '../public/public.decorator';

/**
 * The caller's own settings, and anybody's public profile.
 *
 * The template shipped `POST /users`, `GET /users`, `GET /users/:id`,
 * `PATCH /users/:id` and `DELETE /users/:id`. Those five are still gone:
 *
 * - Users are provisioned automatically by `ClerkAuthGuard` on the first
 *   authenticated request, so `POST /users` had nobody to serve.
 * - `name`, `email` and `imageUrl` are owned by Clerk. `WebhooksService`
 *   overwrites all three on every Clerk event, so `PATCH /users/:id` would write
 *   a value that silently reverts, and would disagree with Clerk until that
 *   happened. They are edited through Clerk's own profile UI instead.
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
 * `GET /users/:username` is a profile read, not user CRUD. It is `@Public()`,
 * because a profile is the thing you look at when you are signed out, and it
 * selects a fixed set of public fields — no email, no role, no Clerk id. A
 * private profile answers 404 to everybody but its owner, so this route cannot be
 * used to confirm that a username exists.
 *
 * `UserRole.ADMIN` is not orphaned by any of this: `DELETE /resources/:id` still
 * uses it, so `pnpm user:set-role` still has a purpose.
 */
@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me/settings')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get your own settings' })
  @ApiOkResponse({ type: MySettingsDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findMySettings(@CurrentUserId() userId: string) {
    return this.usersService.findMySettings(userId);
  }

  @Patch('me/settings')
  @ApiBearerAuth()
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

  @Get('me/profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get your own profile' })
  @ApiOkResponse({ type: ProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findMyProfile(@CurrentUserId() userId: string) {
    return this.usersService.findMyProfile(userId);
  }

  @Patch('me/profile')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update your own profile (username, bio, profile privacy)',
  })
  @ApiOkResponse({ type: ProfileResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation failed, or the username is not a shape we issue',
  })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiConflictResponse({
    description: 'The username is reserved, previously released, or taken',
  })
  updateMyProfile(
    @CurrentUserId() userId: string,
    @Body() dto: UpdateMyProfileDto,
  ) {
    return this.usersService.updateMyProfile(userId, dto);
  }

  /**
   * A public profile.
   *
   * Declared after `me/*` on purpose. Nest matches routes in declaration order,
   * and `:username` is a single path segment, so a route declared above would
   * still be matched first — but keeping the literal segments first means a
   * future `/users/...` route cannot be shadowed by a username that happens to
   * look like it.
   */
  @Get(':username')
  @Public()
  @ApiOperation({ summary: "Get somebody's public profile" })
  @ApiOkResponse({ type: ProfileResponseDto })
  @ApiNotFoundResponse({
    description: 'No such profile, or its owner has made it private',
  })
  findByUsername(@Param('username') username: string, @Req() request: Request) {
    // Read even on a public route, exactly as `GET /resources` does: `@Public()`
    // skips the guard, but Clerk's middleware has still parsed the session, so an
    // owner opening their own private profile is not turned away by it.
    return this.usersService.findByUsername(
      username,
      getAuth(request).userId ?? undefined,
    );
  }
}

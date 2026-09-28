import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { UsersService } from './users.service';
import { CreateUserDto } from './dtos/create-user.dto';
import { UpdateMySettingsDto, UpdateUserDto } from './dtos/update-user.dto';
import { MySettingsDto, UserResponseDto } from './dtos/user-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { UserRole } from '../generated/prisma/enums';

@UseGuards(ClerkAuthGuard, RolesGuard)
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a user' })
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  @ApiOperation({ summary: 'List users' })
  @ApiOkResponse({ type: [UserResponseDto] })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one user' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  // Declared ahead of `:id` so the literal path is matched, not swallowed as
  // an id. The id always comes from the session, so there is no route by which
  // one account can set another's settings.
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

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a user (admin only)' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a user (admin only)' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
}

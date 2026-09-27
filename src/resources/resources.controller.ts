import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ResourcesService } from './resources.service';
import { CreateResourceDto } from './dtos/create-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';
import { ListResourcesQueryDto } from './dtos/list-resources-query.dto';
import { ResourceResponseDto } from './dtos/resource-response.dto';
import { ClerkAuthGuard } from '../clerk-auth/clerk-auth.guard';
import { CurrentUserId } from '../clerk-auth/current-user.decorator';
import { RolesGuard } from '../roles/roles.guard';
import { Roles } from '../roles/roles.decorator';
import { Public } from '../public/public.decorator';
import { UserRole } from '../generated/prisma/enums';

@UseGuards(ClerkAuthGuard, RolesGuard)
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Share a resource' })
  @ApiCreatedResponse({ type: ResourceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  create(
    @CurrentUserId() contributorId: string,
    @Body() createResourceDto: CreateResourceDto,
  ) {
    return this.resourcesService.create(createResourceDto, contributorId);
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'List resources, optionally filtered by tag' })
  @ApiOkResponse({ type: [ResourceResponseDto] })
  @ApiBadRequestResponse({ description: 'Invalid query parameter' })
  findAll(@Query() query: ListResourcesQueryDto) {
    return this.resourcesService.findAll(query.tag);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get one resource' })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  findOne(@Param('id') id: string) {
    return this.resourcesService.findOne(id);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a resource' })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  update(
    @Param('id') id: string,
    @Body() updateResourceDto: UpdateResourceDto,
  ) {
    return this.resourcesService.update(id, updateResourceDto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a resource (admin only)' })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiUnauthorizedResponse({ description: 'No valid Clerk session' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  @ApiNotFoundResponse({ description: 'No resource with that id' })
  remove(@Param('id') id: string) {
    return this.resourcesService.remove(id);
  }
}

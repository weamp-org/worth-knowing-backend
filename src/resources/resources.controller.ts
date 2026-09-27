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

import { ResourcesService } from './resources.service';
import { CreateResourceDto } from './dtos/create-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';
import { ListResourcesQueryDto } from './dtos/list-resources-query.dto';
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
  create(
    @CurrentUserId() contributorId: string,
    @Body() createResourceDto: CreateResourceDto,
  ) {
    return this.resourcesService.create(createResourceDto, contributorId);
  }

  @Get()
  @Public()
  findAll(@Query() query: ListResourcesQueryDto) {
    return this.resourcesService.findAll(query.tag);
  }

  @Get(':id')
  @Public()
  findOne(@Param('id') id: string) {
    return this.resourcesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateResourceDto: UpdateResourceDto,
  ) {
    return this.resourcesService.update(id, updateResourceDto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.resourcesService.remove(id);
  }
}

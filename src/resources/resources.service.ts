import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateResourceDto } from './dtos/create-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';

/**
 * Read shape for the public API. A resource whose contributor has been
 * deleted is still returned, just without the attribution.
 */
const resourceWithContributor = {
  contributor: { select: { id: true, name: true, imageUrl: true } },
} as const;

@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateResourceDto, contributorId: string) {
    return this.prisma.resource.create({
      data: { ...dto, contributorId },
      include: resourceWithContributor,
    });
  }

  findAll() {
    return this.prisma.resource.findMany({
      include: resourceWithContributor,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id },
      include: resourceWithContributor,
    });

    if (!resource) throw new NotFoundException(`Resource ${id} not found`);

    return resource;
  }

  async update(id: string, dto: UpdateResourceDto) {
    await this.findOne(id);

    return this.prisma.resource.update({
      where: { id },
      data: dto,
      include: resourceWithContributor,
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.resource.delete({ where: { id } });
  }
}

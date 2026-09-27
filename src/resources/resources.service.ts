import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import { CreateResourceDto } from './dtos/create-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';

/**
 * Read shape for the public API. A resource whose contributor has been deleted
 * is still returned, just without the attribution.
 */
const resourceInclude = {
  contributor: { select: { id: true, name: true, imageUrl: true } },
  tags: { orderBy: { name: 'asc' } },
} as const;

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
  ) {}

  async create(dto: CreateResourceDto, contributorId: string) {
    const { tags, ...fields } = dto;
    const tagRows = this.tagsService.normalizeTags(tags);

    await this.tagsService.ensureTags(tagRows);

    return this.prisma.resource.create({
      data: {
        ...fields,
        contributorId,
        tags: { connect: tagRows.map(({ slug }) => ({ slug })) },
      },
      include: resourceInclude,
    });
  }

  findAll(tag?: string) {
    return this.prisma.resource.findMany({
      where: tag ? { tags: { some: { slug: tag } } } : undefined,
      include: resourceInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id },
      include: resourceInclude,
    });

    if (!resource) throw new NotFoundException(`Resource ${id} not found`);

    return resource;
  }

  async update(id: string, dto: UpdateResourceDto) {
    await this.findOne(id);

    const { tags, ...fields } = dto;
    const data: Prisma.ResourceUpdateInput = { ...fields };

    // `tags` is absent from a partial update that did not mention it. Setting
    // it unconditionally would silently strip every tag off the resource.
    if (tags !== undefined) {
      const tagRows = this.tagsService.normalizeTags(tags);

      await this.tagsService.ensureTags(tagRows);

      // `set` replaces the whole set; `connect` would only ever add.
      data.tags = { set: tagRows.map(({ slug }) => ({ slug })) };
    }

    return this.prisma.resource.update({
      where: { id },
      data,
      include: resourceInclude,
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    return this.prisma.resource.delete({ where: { id } });
  }
}

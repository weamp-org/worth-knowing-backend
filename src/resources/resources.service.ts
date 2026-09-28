import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import { CreateResourceDto } from './dtos/create-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';
import { decodeCursor, encodeCursor } from './cursor.util';
import { DEFAULT_PAGE_SIZE } from './dtos/list-resources-query.dto';

/**
 * Read shape for the public API. A resource whose contributor has been deleted
 * is still returned, just without the attribution.
 */
const resourceInclude = {
  contributor: { select: { id: true, name: true, imageUrl: true } },
  tags: { orderBy: { name: 'asc' } },
} as const;

/**
 * Newest first, with `id` as a tiebreaker. `createdAt` alone is not unique, and
 * without a total order a cursor can skip or repeat rows when several resources
 * share a timestamp — which they will, since `now()` has millisecond resolution.
 */
const resourceOrderBy = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.ResourceOrderByWithRelationInput[];

type ResourceWithRelations = Prisma.ResourceGetPayload<{
  include: typeof resourceInclude;
}>;

/**
 * Whether a Prisma failure is a bad cursor rather than a real fault.
 *
 * In practice Prisma 7 returns an empty page for a cursor whose row is gone,
 * which is the behaviour we want: a resource can be deleted between a client
 * reading a page and requesting the next, and a 400 there would be a spurious
 * error. This is a guard for the paths that do raise — P2025 for a missing
 * cursor row, P2023 for inconsistent column data — so they surface as a client
 * error rather than a 500 leaking driver text.
 */
function isCursorNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2025' || error.code === 'P2023')
  );
}

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

  /**
   * Keyset-paginated list, newest first.
   *
   * `take` is one over the requested page so `hasMore` can be answered without a
   * `COUNT(*)` on every request; the extra row is trimmed before returning.
   */
  async findAll(tag?: string, limit?: number, cursor?: string) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    let rows: ResourceWithRelations[];

    try {
      rows = await this.prisma.resource.findMany({
        where: tag ? { tags: { some: { slug: tag } } } : undefined,
        orderBy: resourceOrderBy,
        take: take + 1,
        ...(cursor
          ? { cursor: { id: decodeCursor(cursor) }, skip: 1 }
          : undefined),
        include: resourceInclude,
      });
    } catch (error) {
      // A well-formed cursor whose row no longer exists surfaces from Prisma as
      // P2025. That is a client error, not a server fault, and it should not leak
      // the driver's error text.
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
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

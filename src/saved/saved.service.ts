import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  decodeCursor,
  encodeCursor,
  isCursorNotFound,
} from '../pagination/cursor.util';
import {
  resourceInclude,
  toResourceResponse,
  type ResourceWithRelations,
} from '../resources/resource-read';
import { DEFAULT_PAGE_SIZE } from './dtos/list-saved-query.dto';

@Injectable()
export class SavedService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's saved resources, newest saved first, keyset-paginated.
   *
   * Paged over `SavedResource` rather than `Resource`, because the order is when
   * somebody *saved* it — which for a two-year-old contribution may be
   * yesterday. Ordering by the resource's own `createdAt` would sort a list of
   * bookmarks into reverse order of when the bookmarks happened.
   *
   * The resources go through `toResourceResponse`, so an anonymously shared
   * resource in somebody's saved list stays anonymous to them too. Saving is not
   * a way to un-withhold a name, and it is not re-attributed to the saver.
   */
  async findMine(userId: string, limit?: number, cursor?: string) {
    const take = limit ?? DEFAULT_PAGE_SIZE;

    let rows: {
      resourceId: string;
      resource: ResourceWithRelations;
    }[];

    try {
      rows = await this.prisma.savedResource.findMany({
        where: { userId },
        orderBy: savedResourceOrderBy,
        take: take + 1,
        ...(cursor
          ? {
              // The composite primary key, not `{ resourceId }` — a resource can
              // sit in many people's saved lists, so it is not unique on its own.
              // `userId` is known from the session, so the opaque cursor only
              // carries the half that varies.
              cursor: {
                userId_resourceId: {
                  userId,
                  resourceId: decodeCursor(cursor),
                },
              },
              skip: 1,
            }
          : undefined),
        include: { resource: { include: resourceInclude } },
      });
    } catch (error) {
      // A resource deleted between pages. Same reasoning as the resource feed: an
      // empty page is right, a 400 would be noise.
      if (isCursorNotFound(error)) {
        throw new BadRequestException('Invalid cursor');
      }
      throw error;
    }

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);

    return {
      items: items.map((row) => toResourceResponse(row.resource, userId)),
      nextCursor: hasMore && last ? encodeCursor(last.resourceId) : null,
    };
  }

  /**
   * Whether the caller has saved this resource.
   *
   * A separate route rather than a field on the resource, because it is the one
   * part of a resource's state that is per-viewer: `savedCount` is public, this
   * is not. Same split as `GET /resources/:id/mine`.
   */
  async isSaved(resourceId: string, userId: string): Promise<boolean> {
    const saved = await this.prisma.savedResource.findUnique({
      where: { userId_resourceId: { userId, resourceId } },
      select: { resourceId: true },
    });

    return saved !== null;
  }

  /**
   * Bookmarks a resource.
   *
   * Any resource on the site, not only the caller's own — the whole point is to
   * keep something somebody else found.
   *
   * Idempotent, and explicitly so. The primary key is what prevents a duplicate;
   * `skipDuplicates` is what makes two simultaneous clicks both succeed into one
   * row instead of one raising P2002. A 409 would punish somebody for a
   * double-click, and the end state they asked for already exists.
   *
   * Returns the resource, not the saved row: the caller wants the new count to
   * render, and the count lives on the resource.
   */
  async save(resourceId: string, userId: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      include: resourceInclude,
    });

    // Checked before the write so a typo'd id is a 404 naming the problem rather
    // than a foreign-key violation surfacing as a 500. The FK still enforces it.
    if (!resource)
      throw new NotFoundException(`Resource ${resourceId} not found`);

    await this.prisma.savedResource.createMany({
      data: { userId, resourceId },
      skipDuplicates: true,
    });

    return toResourceResponse(resource, userId);
  }

  /**
   * Removes a bookmark.
   *
   * Idempotent for the same reason {@link save} is: "it is not saved" is exactly
   * the state the caller asked for, so there is nothing to report.
   *
   * The resource is not required to still exist — if it was deleted outright the
   * saved rows cascaded away and the caller's request has still been honoured.
   */
  async unsave(resourceId: string, userId: string) {
    await this.prisma.savedResource.deleteMany({
      where: { userId, resourceId },
    });

    return this.reread(resourceId, userId);
  }

  /**
   * Re-reads a resource after a write, for the refreshed count.
   *
   * A null here would mean the resource was deleted between the write and this
   * read, which is a race rather than a state, and 404 is the honest answer.
   */
  private async reread(resourceId: string, viewerId: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      include: resourceInclude,
    });

    if (!resource) {
      throw new NotFoundException(`Resource ${resourceId} not found`);
    }

    return toResourceResponse(resource, viewerId);
  }
}

/**
 * Newest saved first, with `resourceId` as a tiebreaker.
 *
 * `savedAt` alone is not unique, and a keyset cursor over a non-total order
 * skips or repeats rows. Paired with `SavedResource_userId_savedAt_resourceId_idx`.
 */
const savedResourceOrderBy = [
  { savedAt: 'desc' },
  { resourceId: 'desc' },
] satisfies Prisma.SavedResourceOrderByWithRelationInput[];

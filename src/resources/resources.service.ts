import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import { UserRole } from '../generated/prisma/enums';
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
 * Withholds the contributor from a resource shared anonymously.
 *
 * Both the `contributor` object and the raw `contributorId` go, because
 * keeping the id would defeat the point: the same id appears on the person's
 * public contributions, so anyone comparing two posts could link the anonymous
 * one back to a name. Nothing is left to correlate on.
 *
 * The owner is not redacted from their own resource, which is what lets the
 * edit form load and pre-fill. A stranger presenting any token is still
 * redacted — only an exact `contributorId` match is let through.
 *
 * `isAnonymous` stays on the response so a client can tell an anonymous post
 * from one whose contributor was deleted. Those are different states and the
 * UI words them differently.
 */
function redactAnonymous(
  resource: ResourceWithRelations,
  viewerId?: string,
): ResourceWithRelations {
  if (!resource.isAnonymous || resource.contributorId === viewerId) {
    return resource;
  }

  return { ...resource, contributor: null, contributorId: null };
}

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
    const { tags, isAnonymous, ...fields } = dto;
    const tagRows = this.tagsService.normalizeTags(tags);

    await this.tagsService.ensureTags(tagRows);

    // The standing preference only applies when the client expressed no
    // preference of its own. The resolved value is stored on the resource, so
    // a later change to the setting cannot retroactively alter what was shared.
    const resolvedAnonymous =
      isAnonymous ?? (await this.anonymousByDefault(contributorId));

    return this.prisma.resource.create({
      data: {
        ...fields,
        isAnonymous: resolvedAnonymous,
        contributorId,
        tags: { connect: tagRows.map(({ slug }) => ({ slug })) },
      },
      include: resourceInclude,
    });
  }

  /**
   * The contributor's standing preference.
   *
   * Defaults to `false` when the row is missing, which can only happen if the
   * guard has not provisioned it — better to share publicly than to fail.
   */
  private async anonymousByDefault(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { anonymousByDefault: true },
    });

    return user?.anonymousByDefault ?? false;
  }

  /**
   * Keyset-paginated list, newest first.
   *
   * `take` is one over the requested page so `hasMore` can be answered without a
   * `COUNT(*)` on every request; the extra row is trimmed before returning.
   */
  async findAll(
    tag?: string,
    limit?: number,
    cursor?: string,
    viewerId?: string,
  ) {
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
      items: items.map((row) => redactAnonymous(row, viewerId)),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  async findOne(id: string, viewerId?: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id },
      include: resourceInclude,
    });

    if (!resource) throw new NotFoundException(`Resource ${id} not found`);

    return redactAnonymous(resource, viewerId);
  }

  /**
   * Whether the caller contributed this resource.
   *
   * Separate from the response body because a caller who cannot see the
   * contributor still needs to know whether the resource is theirs — that is
   * what decides whether an edit affordance is shown.
   */
  async isMine(id: string, viewerId: string): Promise<boolean> {
    const resource = await this.prisma.resource.findUnique({
      where: { id },
      select: { contributorId: true },
    });

    return resource?.contributorId === viewerId;
  }

  /**
   * Whether the actor may change or remove the resource, and throws if not.
   *
   * The contributor, or any admin. This lives in the service rather than behind
   * `@Roles` on the controller because `RolesGuard` short-circuits with
   * `if (!requiredRoles) return true` — a route that must accept *either* an
   * owner or an admin cannot be expressed with that decorator, so nothing would
   * ever ask what role the caller has. Deciding here keeps the rule in one
   * place for both writes.
   *
   * Without it, any signed-in user could flip `isAnonymous` on someone else's
   * contribution and undo the one control the anonymity feature exists to
   * provide — or delete a contribution outright. The local `User.id` is the
   * Clerk user id, so the comparison is direct.
   */
  private async assertCanModify(id: string, actorId: string) {
    // Read as the actor rather than anonymously. For the owner that leaves
    // `contributorId` populated, which is exactly what the check below needs;
    // reading it redacted would null that field and lock the owner out of their
    // own anonymous resource.
    const existing = await this.findOne(id, actorId);

    if (existing.contributorId === actorId) return;

    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true },
    });

    if (actor?.role !== UserRole.ADMIN) {
      throw new ForbiddenException('You can only change your own resources');
    }
  }

  async update(id: string, dto: UpdateResourceDto, actorId: string) {
    await this.assertCanModify(id, actorId);

    const { tags, ...fields } = dto;
    const data: Prisma.ResourceUpdateInput = { ...fields };

    // `isAnonymous` is absent from a partial update that did not mention it.
    // Spreading `undefined` into a Prisma update is not a way to leave a column
    // alone, so an explicit `null` is dropped here too.
    if (data.isAnonymous === null) {
      delete data.isAnonymous;
    }

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

  async remove(id: string, actorId: string) {
    await this.assertCanModify(id, actorId);

    // `include` so the response matches the `ResourceResponseDto` the route
    // documents. It costs a second query for a body the client ignores, but the
    // alternative is a documented shape the endpoint does not actually return.
    return this.prisma.resource.delete({
      where: { id },
      include: resourceInclude,
    });
  }
}

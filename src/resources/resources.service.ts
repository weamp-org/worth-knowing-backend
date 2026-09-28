import {
  BadRequestException,
  ConflictException,
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

/** P2002: a unique index rejected the write. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * The same link, from the same person, twice.
 *
 * Wording matters here. This must not read as a judgement that a duplicate is
 * worthless: two *different* people sharing the same link is the product
 * working, and each `why` is the value. Only the author repeating themselves is
 * noise, so the message points at the edit they probably wanted rather than
 * telling them the resource is not shareable.
 */
const DUPLICATE_MESSAGE =
  'You have already shared this link. Edit that contribution instead of posting it again.';

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
  ) {}

  /**
   * Whether this contributor already shared this exact link.
   *
   * The `@@unique([contributorId, url])` index is what actually enforces this;
   * this read exists to produce a 409 with a sentence a person can act on
   * instead of a bare P2002. A 409 also beats letting the write fail, because a
   * contributor who double-submits gets a form error naming the problem rather
   * than a 500.
   *
   * Deliberately *not* global. Two people independently finding the same
   * resource worth knowing is the product working — each brings a different
   * `why`, and deduplicating would throw one of those away, which is the last
   * thing this product should lose. Only a repeated submission by the author is
   * noise, and rejecting that costs nobody else their contribution.
   */
  private async assertNotAlreadyShared(
    url: string,
    contributorId: string,
    /** Excluded, so re-saving a resource without changing its URL is allowed. */
    exceptId?: string,
  ) {
    const existing = await this.prisma.resource.findFirst({
      where: {
        url,
        contributorId,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });

    if (existing) throw new ConflictException(DUPLICATE_MESSAGE);
  }

  async create(dto: CreateResourceDto, contributorId: string) {
    const { tags, isAnonymous, ...fields } = dto;
    const tagRows = this.tagsService.normalizeTags(tags);

    await this.assertNotAlreadyShared(dto.url, contributorId);

    await this.tagsService.ensureTags(tagRows);

    // The standing preference only applies when the client expressed no
    // preference of its own. The resolved value is stored on the resource, so
    // a later change to the setting cannot retroactively alter what was shared.
    const resolvedAnonymous =
      isAnonymous ?? (await this.anonymousByDefault(contributorId));

    try {
      return await this.prisma.resource.create({
        data: {
          ...fields,
          isAnonymous: resolvedAnonymous,
          contributorId,
          tags: { connect: tagRows.map(({ slug }) => ({ slug })) },
        },
        include: resourceInclude,
      });
    } catch (error) {
      // Two submissions that both pass the read above. The index is what
      // actually decides, so a race has to come out the same way as a
      // deliberate duplicate rather than as a 500.
      if (isUniqueViolation(error))
        throw new ConflictException(DUPLICATE_MESSAGE);

      throw error;
    }
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

    // Only when the URL is actually changing. Re-saving a resource without
    // touching its URL must not trip the check against itself, hence the
    // exclusion of this resource's own row.
    //
    // `data.url` is typed as the Prisma field-update shape, so a plain string
    // needs unwrapping. An admin editing somebody else's resource is still
    // checked against *that* contributor's other resources, not the admin's:
    // the index is on `(contributorId, url)`, so moving a contribution onto a
    // link its own author already used is the collision that matters.
    if (typeof dto.url === 'string') {
      const owner = await this.prisma.resource.findUnique({
        where: { id },
        select: { contributorId: true },
      });

      if (owner?.contributorId) {
        await this.assertNotAlreadyShared(dto.url, owner.contributorId, id);
      }
    }

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

    try {
      return await this.prisma.resource.update({
        where: { id },
        data,
        include: resourceInclude,
      });
    } catch (error) {
      // Same reason as in `create`: the index decides, and a losing racer must
      // surface the same 409 a deliberate duplicate gets.
      if (isUniqueViolation(error))
        throw new ConflictException(DUPLICATE_MESSAGE);

      throw error;
    }
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
